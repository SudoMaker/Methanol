/* Copyright Yukino Song, SudoMaker Ltd.
 *
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 * 	http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { clientsClaim } from 'workbox-core'
import { registerRoute } from 'workbox-routing'
import { StaleWhileRevalidate } from 'workbox-strategies'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'

const resolveBasePrefix = () => {
	let base = import.meta.env?.BASE_URL || '/'
	if (!base || base === '/' || base === './') return ''
	if (base.startsWith('http://') || base.startsWith('https://')) {
		try {
			base = new URL(base).pathname
		} catch {
			return ''
		}
	}
	if (!base.startsWith('/')) return ''
	if (base.endsWith('/')) base = base.slice(0, -1)
	return base
}

const withBase = (path) => {
	const prefix = resolveBasePrefix()
	if (!prefix || path.startsWith(`${prefix}/`)) return path
	return `${prefix}${path}`
}

self.skipWaiting()
clientsClaim()

const NOT_FOUND_URL = withBase('/404.html')
const OFFLINE_FALLBACK_URL = withBase('/offline.html')

const PAGES_CACHE = withBase(':methanol-pages-swr')
const ASSETS_CACHE = withBase(':methanol-assets-swr')

// Precache the 404/offline fallback pages during install
self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await openCache(PAGES_CACHE)
			try {
				await cache.add(NOT_FOUND_URL)
			} catch {}
			try {
				await cache.add(OFFLINE_FALLBACK_URL)
			} catch {}
		})()
	)
})

// Enable navigation preload (latency improvement for navigations)
self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			try {
				await self.registration.navigationPreload?.enable()
			} catch {}
			// New SW activation => refresh cached entries progressively.
			try {
				await idbSet(KEY_FORCE, 1)
				await idbSet(KEY_INDEX, 0)
			} catch {}

			warmManifestResumable()
		})()
	)
})

function stripSearch(urlString) {
	const u = new URL(urlString, self.location.href)
	u.search = ''
	u.hash = ''
	return u
}

function hasExtension(pathname) {
	const last = pathname.pathname.split('/').pop() || ''
	return last.includes('.')
}

/**
 * Clean-url mapping rules (network fallback candidates)
 * - /foo/ -> /foo/index.html
 * - /foo  -> /foo.html
 */
function htmlFallbackCandidates(pathname) {
	if (pathname.endsWith('/')) return [pathname + 'index.html']
	if (!hasExtension({ pathname })) return [pathname + '.html']
	return []
}

/**
 * Normalized HTML cache key:
 * - /foo/ -> /foo/index.html
 * - /foo  -> /foo.html
 * - ignore query params
 */
function toNormalizedHtmlCacheKeyUrl(url) {
	const u = stripSearch(url.toString())

	if (u.pathname.endsWith('/')) {
		u.pathname += 'index.html'
		return u
	}
	if (!hasExtension(u)) {
		u.pathname += '.html'
		return u
	}
	return u
}

function isHtmlNavigation(request) {
	return request.mode === 'navigate'
}

function isPrefetch(request) {
	const purpose = request.headers.get('Purpose') || request.headers.get('Sec-Purpose')
	return purpose === 'prefetch'
}

function isAssetRequest(request) {
	return (
		request.destination === 'script' ||
		request.destination === 'style' ||
		request.destination === 'image' ||
		request.destination === 'font'
	)
}

function buildConditionalRequest(request, cached) {
	const headers = new Headers(request.headers)
	const etag = cached?.headers?.get?.('ETag')
	const lastModified = cached?.headers?.get?.('Last-Modified')
	if (etag) {
		headers.set('If-None-Match', etag)
	} else if (lastModified) {
		headers.set('If-Modified-Since', lastModified)
	}
	return new Request(request.url, {
		method: 'GET',
		headers,
		credentials: request.credentials,
		redirect: request.redirect,
		referrer: request.referrer,
		referrerPolicy: request.referrerPolicy,
		integrity: request.integrity,
		cache: 'no-cache',
		mode: request.mode
	})
}

async function openCache(name) {
	return caches.open(name)
}

async function matchAnyCache(urlString) {
	const keyUrl = stripSearch(urlString).toString()
	return caches.match(keyUrl, { ignoreSearch: true })
}

async function matchFromCache(cacheName, urlString) {
	const cache = await openCache(cacheName)
	const keyUrl = stripSearch(urlString).toString()
	return cache.match(keyUrl, { ignoreSearch: true })
}

async function putIntoCache(cacheName, urlString, response) {
	const cache = await openCache(cacheName)
	const keyUrl = stripSearch(urlString).toString()
	await cache.put(keyUrl, response)
}

const assetStrategy = new StaleWhileRevalidate({
	cacheName: ASSETS_CACHE,
	plugins: [new CacheableResponsePlugin({ statuses: [200] })]
})

function fetchWithTimeout(request, timeout = 8000) {
	return Promise.race([
		fetch(request),
		new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
	])
}

async function fetchWithCleanUrlFallback(event, originalRequest, { usePreload = true, allowNotOk = false } = {}) {
	const originalUrl = new URL(originalRequest.url)

	// Prefer preload response for the ORIGINAL navigation URL
	if (usePreload && event.preloadResponse) {
		try {
			// Ensure preload has a chance to settle to avoid Chrome cancellation warnings.
			event.waitUntil(event.preloadResponse.catch(() => {}))
			const preloaded = await event.preloadResponse
			if (preloaded && preloaded.ok) return preloaded
		} catch {}
	}

	try {
		const res = await fetchWithTimeout(originalRequest.clone())
		if (res && (allowNotOk || res.ok)) return res
	} catch {}

	const fallbacks = htmlFallbackCandidates(originalUrl.pathname)
	for (const p of fallbacks) {
		const u2 = new URL(originalUrl.toString())
		u2.pathname = p

		try {
			const req2 = new Request(u2.toString(), {
				method: 'GET',
				headers: originalRequest.headers,
				credentials: originalRequest.credentials,
				redirect: originalRequest.redirect,
				referrer: originalRequest.referrer,
				referrerPolicy: originalRequest.referrerPolicy,
				integrity: originalRequest.integrity,
				cache: originalRequest.cache
			})

			const res2 = await fetchWithTimeout(req2)
			if (res2 && (allowNotOk || res2.ok)) return res2
		} catch {}
	}

	return null
}

function withStatus(response, status) {
	const headers = new Headers(response.headers)
	return new Response(response.clone().body, { status, statusText: response.statusText, headers })
}

async function serveNotFound() {
	const cached = await matchFromCache(PAGES_CACHE, NOT_FOUND_URL)
	if (cached) return withStatus(cached, 404)

	try {
		const res = await fetch(NOT_FOUND_URL)
		if (res && res.ok) {
			await putIntoCache(PAGES_CACHE, NOT_FOUND_URL, res.clone())
			return withStatus(res, 404)
		}
	} catch {}

	return new Response('Not Found', {
		status: 404,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' }
	})
}

async function serveOffline() {
	const cached = await matchFromCache(PAGES_CACHE, OFFLINE_FALLBACK_URL)
	if (cached) return withStatus(cached, 503)

	const anyCached = await matchAnyCache(OFFLINE_FALLBACK_URL)
	if (anyCached) {
		await putIntoCache(PAGES_CACHE, OFFLINE_FALLBACK_URL, anyCached.clone())
		return withStatus(anyCached, 503)
	}

	return new Response('Offline', {
		status: 503,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' }
	})
}

// NAVIGATIONS: instant-if-cached + background revalidate + fallback rewrite + offline fallback /offline.html
registerRoute(
	({ request, url }) => (isHtmlNavigation(request) || isPrefetch(request)) && url.origin === self.location.origin,
	async ({ event, request }) => {
		if (isHtmlNavigation(request) && event.preloadResponse) {
			event.waitUntil(event.preloadResponse.catch(() => {}))
		}
		const normalizedKey = toNormalizedHtmlCacheKeyUrl(new URL(request.url)).toString()

		const cached = await matchFromCache(PAGES_CACHE, normalizedKey)
		if (cached) {
			event.waitUntil(
				(async () => {
					const revalidateRequest = buildConditionalRequest(request, cached)
					const fresh = await fetchWithCleanUrlFallback(event, revalidateRequest, {
						usePreload: false,
						allowNotOk: true
					})
					if (fresh && fresh.status === 304) return
					if (fresh && fresh.ok) await putIntoCache(PAGES_CACHE, normalizedKey, fresh.clone())
				})()
			)
			return cached
		}

		const fresh = await fetchWithCleanUrlFallback(event, request, {
			usePreload: isHtmlNavigation(request),
			allowNotOk: true
		})
		if (fresh && fresh.ok) {
			await putIntoCache(PAGES_CACHE, normalizedKey, fresh.clone())
			return fresh
		}
		if (fresh && fresh.status === 404) {
			return serveNotFound(request)
		}

		if (fresh) return fresh

		return serveOffline(request)
	}
)

registerRoute(
	({ request, url }) => url.origin === self.location.origin && isAssetRequest(request),
	async (args) => {
		const u = stripSearch(args.request.url)
		const normalizedRequest = new Request(u.toString(), {
			method: 'GET',
			headers: args.request.headers,
			credentials: args.request.credentials,
			redirect: args.request.redirect,
			referrer: args.request.referrer,
			referrerPolicy: args.request.referrerPolicy,
			integrity: args.request.integrity,
			cache: args.request.cache,
			mode: args.request.mode
		})

		return assetStrategy.handle({ ...args, request: normalizedRequest })
	}
)

const DB_NAME = withBase(':methanol-pwa-warm-db')
const DB_STORE = 'kv'
const KEY_INDEX = 'warmIndex'
const KEY_LEASE = 'warmLease'
const KEY_FORCE = 'warmForce'

function idbOpen() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1)
		req.onupgradeneeded = () => {
			const db = req.result
			if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE)
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
}

async function idbGet(key) {
	const db = await idbOpen()
	try {
		return await new Promise((resolve, reject) => {
			const tx = db.transaction(DB_STORE, 'readonly')
			const store = tx.objectStore(DB_STORE)
			const req = store.get(key)
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})
	} finally {
		db.close()
	}
}

async function idbSet(key, value) {
	const db = await idbOpen()
	try {
		await new Promise((resolve, reject) => {
			const tx = db.transaction(DB_STORE, 'readwrite')
			const store = tx.objectStore(DB_STORE)
			const req = store.put(value, key)
			req.onsuccess = () => resolve()
			req.onerror = () => reject(req.error)
		})
	} finally {
		db.close()
	}
}

function nowMs() {
	return Date.now()
}

function randomId() {
	return `${nowMs().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function tryAcquireLease(leaseMs) {
	const leaseId = randomId()
	const deadline = nowMs() + leaseMs

	const cur = await idbGet(KEY_LEASE)
	if (cur && cur.expiresAt && cur.expiresAt > nowMs()) return null

	await idbSet(KEY_LEASE, { id: leaseId, expiresAt: deadline })

	const verify = await idbGet(KEY_LEASE)
	if (!verify || verify.id !== leaseId) return null

	return { id: leaseId }
}

async function renewLease(lease, leaseMs) {
	const cur = await idbGet(KEY_LEASE)
	if (!cur || cur.id !== lease.id) return false
	await idbSet(KEY_LEASE, { id: lease.id, expiresAt: nowMs() + leaseMs })
	return true
}

async function releaseLease(lease) {
	const cur = await idbGet(KEY_LEASE)
	if (cur && cur.id === lease.id) {
		await idbSet(KEY_LEASE, { id: '', expiresAt: 0 })
	}
}

async function warmManifestResumable({ force = false } = {}) {
	const manifest = self.__WB_MANIFEST || []
	if (!manifest.length) return

	const forceFlag = await idbGet(KEY_FORCE)
	if (forceFlag) force = true

	const leaseMs = 30_000
	const lease = await tryAcquireLease(leaseMs)
	if (!lease) return

	let completed = false
	try {
		let index = (await idbGet(KEY_INDEX)) || 0
		if (index < 0) index = 0

		const urls = manifest.map((e) => new URL(e.url, self.location.href).toString())
		const batchSize = 5

		for (let i = index; i < urls.length; i += batchSize) {
			const ok = await renewLease(lease, leaseMs)
			if (!ok) return

			const slice = urls.slice(i, i + batchSize)

			await Promise.allSettled(
				slice.map(async (u) => {
					const abs = new URL(u, self.location.href)
					if (abs.origin !== self.location.origin) return

					const isHtml = abs.pathname.endsWith('.html')

					if (isHtml) {
						const key = toNormalizedHtmlCacheKeyUrl(abs).toString()
						if (!force && (await matchFromCache(PAGES_CACHE, key))) return

						try {
							const res = await fetch(u)
							if (res && res.ok) await putIntoCache(PAGES_CACHE, key, res)
						} catch {}
						return
					}

					const key = stripSearch(u).toString()
					if (!force && (await matchFromCache(ASSETS_CACHE, key))) return

					try {
						const res = await fetch(u)
						if (res && res.ok) await putIntoCache(ASSETS_CACHE, key, res)
					} catch {}
				})
			)

			await idbSet(KEY_INDEX, i + batchSize)
			await new Promise((r) => setTimeout(r, 0))
		}

		await idbSet(KEY_INDEX, urls.length)
		completed = true
	} finally {
		if (completed) {
			await idbSet(KEY_FORCE, 0)
		}
		await releaseLease(lease)
	}
}

self.addEventListener('message', (event) => {
	if (event.data?.type !== 'METHANOL_WARM_MANIFEST') return
	event.waitUntil(warmManifestResumable())
})
