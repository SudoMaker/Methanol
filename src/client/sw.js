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
import { cached, cachedStr } from '../utils.js'

const __WB_MANIFEST = self.__WB_MANIFEST
const BATCH_SIZE = 5

self.skipWaiting()
clientsClaim()

const resolveBasePrefix = cached(() => {
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
})

const resolveCurrentBasePrefix = cached(() => {
	const prefix = resolveBasePrefix()
	if (!prefix) {
		return self.location.origin
	}
	return new URL(prefix, self.location.origin).href
})

const withBase = cachedStr((path) => {
	const prefix = resolveBasePrefix()
	if (!prefix || path.startsWith(`${prefix}/`)) return path
	return `${prefix}${path}`
})

const NOT_FOUND_URL = new URL(withBase('/404.html'), self.location.origin).href.toLowerCase()
const OFFLINE_FALLBACK_URL = new URL(withBase('/offline.html'), self.location.origin).href.toLowerCase()

const PAGES_CACHE = withBase(':methanol-pages-swr')
const ASSETS_CACHE = withBase(':methanol-assets-swr')

const stripBase = cachedStr((url) => {
	const base = resolveCurrentBasePrefix()
	if (!base) return url
	if (url === base) return '/'
	if (url.startsWith(`${base}/`)) return url.slice(base.length)
	return url
})

function isRootOrAssets(url) {
	const basePath = stripBase(url)
	if (basePath.startsWith('/assets/')) return true
	const trimmed = basePath.startsWith('/') ? basePath.slice(1) : basePath
	return trimmed !== '' && !trimmed.includes('/')
}

const getManifestEntries = cached(() => {
	const entries = []
	for (const entry of __WB_MANIFEST) {
		if (!entry?.url) continue
		entries.push({
			url: new URL(entry.url, self.location.href).toString(),
			revision: entry.revision
		})
	}
	return entries
})

const getManifestIndex = cached(() => {
	const map = new Map()
	for (const entry of getManifestEntries()) {
		map.set(manifestKey(entry.url), entry.revision ?? null)
	}
	return map
})

function collectManifestUrls() {
	return getManifestEntries().map((entry) => entry.url)
}

function prioritizeManifestUrls(urls) {
	const prioritized = []
	const other = []

	for (const url of urls) {
		const lower = url.toLowerCase()
		if (lower.endsWith('.css') && isRootOrAssets(url)) {
			prioritized.push(url)
			continue
		}
		if ((lower.endsWith('.js') || lower.endsWith('.mjs')) && isRootOrAssets(url)) {
			prioritized.push(url)
			continue
		}
		if (lower.endsWith('.html') && (lower === NOT_FOUND_URL || lower === OFFLINE_FALLBACK_URL)) {
			prioritized.unshift(url)
			continue
		}
		other.push(url)
	}

	return [prioritized, other]
}

// Precache prioritized entries during install
self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			try {
				await idbSet(KEY_FORCE, 1)
				await idbSet(KEY_INDEX, 0)
			} catch {}
			const pageCache = await openCache(PAGES_CACHE)
			const assetCache = await openCache(ASSETS_CACHE)
			const manifestEntries = getManifestEntries()
			const manifestMap = buildManifestMap(manifestEntries)
			const previousMap = await loadStoredManifestMap()
			const manifestUrls = manifestEntries.map((entry) => entry.url)
			const [prioritized] = prioritizeManifestUrls(manifestUrls)
			const { failedIndex } = await runConcurrentQueue(prioritized, {
				concurrency: BATCH_SIZE,
				handler: async (url) => {
					const isHtml = url.endsWith('.html')
					const cacheName = isHtml ? PAGES_CACHE : ASSETS_CACHE
					const cached = await matchCache(cacheName, url)
					const key = manifestKey(url)
					const currentRevision = manifestMap.get(key) ?? null
					const previousRevision = previousMap.get(key) ?? null
					const shouldFetch = shouldFetchWithRevision({
						cached,
						currentRevision,
						previousRevision
					})
					if (!shouldFetch) return true
					const cache = isHtml ? pageCache : assetCache
					return fetchAndCache(cache, url)
				}
			})
			if (failedIndex !== null) {
				throw new Error('install cache failed')
			}
		})()
	)
})

self.addEventListener('activate', (event) => {
	event.waitUntil(warmManifestResumable())
})

function stripSearch(urlString) {
	const u = new URL(urlString, self.location.href)
	u.search = ''
	u.hash = ''
	return u
}

function manifestKey(urlString) {
	return stripSearch(urlString).toString()
}

function hasExtension(pathname) {
	const last = pathname.split('/').pop() || ''
	return last.includes('.')
}

/**
 * Clean-url mapping rules (network fallback candidates)
 * - /foo/ -> /foo/index.html
 * - /foo  -> /foo.html
 */
function htmlFallback(pathname) {
	if (pathname.endsWith('/')) return pathname + 'index.html'
	if (!hasExtension(pathname)) return pathname + '.html'
	return null
}

/**
 * Normalized HTML cache key:
 * - /foo/ -> /foo/index.html
 * - /foo  -> /foo.html
 * - ignore query params
 */
function normalizeNavigationURL(url) {
	const u = stripSearch(url.toString())

	if (u.pathname.endsWith('/')) {
		u.pathname += 'index.html'
		return u
	}
	if (!hasExtension(u.pathname)) {
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

async function openCache(name) {
	return caches.open(name)
}

const asleep = (timeout) => new Promise((r) => setTimeout(r, timeout))

async function runConcurrentQueue(list, { concurrency, handler, stopOnError = true }) {
	if (!list.length) return { ok: true, failedIndex: null }

	let cursor = 0
	let failedIndex = null

	const workerSet = new Array(concurrency)

	const worker = async (index, data) => {
		const ok = await handler(data)

		if (!ok && stopOnError) {
			if (failedIndex === null || index < failedIndex) failedIndex = index
			return -1
		}

		return index
	}

	for (let i = 0; i < concurrency && cursor < list.length; i++) {
		workerSet[i] = worker(i, list[cursor++], i)
		await asleep(5)
	}

	while (cursor < list.length) {
		const finishedIndex = await Promise.race(workerSet)
		if (finishedIndex < 0) {
			break
		}
		await asleep(1)
		workerSet[finishedIndex] = worker(finishedIndex, list[cursor++])
	}

	await Promise.allSettled(workerSet)

	return { ok: failedIndex === null, failedIndex }
}

function shouldFetchWithRevision({ cached, currentRevision, previousRevision }) {
	if (!cached) return true
	if (currentRevision == null) return false
	if (previousRevision == null) return true
	return currentRevision !== previousRevision
}

async function bufferResponse(response) {
	const body = await response.clone().arrayBuffer()
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	})
}

async function fetchAndCache(cache, urlString) {
	const req = new Request(urlString, {
		redirect: 'follow',
		cache: 'no-store',
		credentials: 'same-origin'
	})

	let res
	try {
		res = await fetch(req)
	} catch {
		return false
	}

	if (!res || !res.ok || res.type === 'opaqueredirect') return false
	const responseUrl = res.url || ''

	let buffered
	try {
		buffered = await bufferResponse(res)
	} catch {
		return false
	}

	await cache.put(stripSearch(urlString).toString(), buffered.clone())
	if (responseUrl && responseUrl !== urlString) {
		const redirectKey = stripSearch(responseUrl).toString()
		if (redirectKey !== stripSearch(urlString).toString()) {
			await cache.put(redirectKey, buffered.clone())
		}
	}
	return true
}

async function matchAnyCache(urlString) {
	const keyUrl = stripSearch(urlString).toString()
	return caches.match(keyUrl, { ignoreSearch: true })
}

async function matchCache(cacheName, urlString) {
	const cache = await openCache(cacheName)
	const keyUrl = stripSearch(urlString).toString()
	return cache.match(keyUrl, { ignoreSearch: true })
}

async function putCache(cacheName, urlString, response) {
	const cache = await openCache(cacheName)
	const keyUrl = stripSearch(urlString).toString()
	let toCache = response
	if (cacheName === PAGES_CACHE || cacheName === ASSETS_CACHE) {
		try {
			toCache = await bufferResponse(response)
		} catch {
			return false
		}
	}

	try {
		await cache.put(keyUrl, toCache.clone())
	} catch {
		return false
	}
	return true
}

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
		const res = await fetchWithTimeout(
			new Request(originalRequest.url, {
				method: 'GET',
				headers: originalRequest.headers,
				credentials: originalRequest.credentials,
				redirect: 'follow',
				referrer: originalRequest.referrer,
				referrerPolicy: originalRequest.referrerPolicy,
				integrity: originalRequest.integrity,
				cache: originalRequest.cache
			})
		)
		if (res && (allowNotOk || res.ok)) return res
	} catch {}

	const fallback = htmlFallback(originalUrl.pathname)

	if (!fallback) {
		return null
	}

	const u2 = new URL(originalUrl.toString())
	u2.pathname = fallback

	try {
		const req2 = new Request(u2.toString(), {
			method: 'GET',
			headers: originalRequest.headers,
			credentials: originalRequest.credentials,
			redirect: 'follow',
			referrer: originalRequest.referrer,
			referrerPolicy: originalRequest.referrerPolicy,
			integrity: originalRequest.integrity,
			cache: originalRequest.cache
		})

		const res2 = await fetchWithTimeout(req2)
		if (res2 && (allowNotOk || res2.ok)) return res2
	} catch {}

	return null
}

function withStatus(response, status) {
	const headers = new Headers(response.headers)
	return new Response(response.clone().body, { status, statusText: response.statusText, headers })
}

async function serveNotFound() {
	const cached = await matchCache(PAGES_CACHE, NOT_FOUND_URL)
	if (cached) return withStatus(cached, 404)

	try {
		const res = await fetch(NOT_FOUND_URL)
		if (res && res.ok) {
			await putCache(PAGES_CACHE, NOT_FOUND_URL, res.clone())
			return withStatus(res, 404)
		}
	} catch {}

	return new Response('Not Found', {
		status: 404,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' }
	})
}

async function serveOffline() {
	const cached = await matchCache(PAGES_CACHE, OFFLINE_FALLBACK_URL)
	if (cached) return withStatus(cached, 503)

	const anyCached = await matchAnyCache(OFFLINE_FALLBACK_URL)
	if (anyCached) {
		await putCache(PAGES_CACHE, OFFLINE_FALLBACK_URL, anyCached.clone())
		return withStatus(anyCached, 503)
	}

	return new Response('Offline', {
		status: 503,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' }
	})
}

// NAVIGATIONS: cache-first for manifest pages, network fallback for others
registerRoute(
	({ request, url }) => (isHtmlNavigation(request) || isPrefetch(request)) && url.origin === self.location.origin,
	async ({ event, request }) => {
		const normalizedKey = normalizeNavigationURL(new URL(request.url)).toString()
		const key = manifestKey(normalizedKey)
		const inManifest = getManifestIndex().has(key)

		if (inManifest) {
			const cached = await matchCache(PAGES_CACHE, normalizedKey)
			if (cached) return cached
		}

		const fresh = await fetchWithCleanUrlFallback(event, request, {
			usePreload: isHtmlNavigation(request),
			allowNotOk: true
		})
		if (fresh && fresh.status === 200) {
			if (inManifest) {
				await putCache(PAGES_CACHE, normalizedKey, fresh.clone())
			}
			return fresh
		}
		if (fresh && fresh.status === 404) {
			return serveNotFound()
		}

		if (fresh) return fresh

		return serveOffline()
	}
)

registerRoute(
	({ request, url }) =>
		url.origin === self.location.origin &&
		request.method === 'GET' &&
		!isHtmlNavigation(request) &&
		!isPrefetch(request) &&
		getManifestIndex().has(manifestKey(request.url)),
	async ({ request }) => {
		const key = manifestKey(request.url)
		const cached = await matchCache(ASSETS_CACHE, key)
		if (cached) return cached

		try {
			const res = await fetch(request)
			if (res && res.status === 200) {
				await putCache(ASSETS_CACHE, key, res.clone())
			}
			return res
		} catch {
			return new Response(null, { status: 503 })
		}
	}
)

const DB_NAME = withBase(':methanol-pwa-warm-db')
const DB_STORE = 'kv'
const KEY_INDEX = 'warmIndex'
const KEY_LEASE = 'warmLease'
const KEY_FORCE = 'warmForce'
const KEY_MANIFEST = 'warmManifest'

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

function buildManifestMap(entries) {
	const map = new Map()
	for (const entry of entries || []) {
		if (!entry?.url) continue
		map.set(manifestKey(entry.url), entry.revision ?? null)
	}
	return map
}

async function loadStoredManifestMap() {
	const stored = await idbGet(KEY_MANIFEST)
	if (!stored) return new Map()
	if (Array.isArray(stored)) return buildManifestMap(stored)
	return new Map()
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
	if (!__WB_MANIFEST.length) return

	const forceFlag = await idbGet(KEY_FORCE)
	if (forceFlag) force = true

	let index = (await idbGet(KEY_INDEX)) ?? 0
	if (index < 0) {
		if (!force) return
		index = 0
	}

	const leaseMs = 30_000
	const lease = await tryAcquireLease(leaseMs)
	if (!lease) return

	let completed = false
	try {
		const manifestEntries = getManifestEntries()
		const manifestMap = buildManifestMap(manifestEntries)
		const previousMap = await loadStoredManifestMap()
		const [, urls] = prioritizeManifestUrls(manifestEntries.map((entry) => entry.url))
		if (!urls.length) return
		if (index >= urls.length) {
			completed = true
			return
		}

		const startIndex = index
		const { failedIndex } = await runConcurrentQueue(urls.slice(startIndex), {
			concurrency: BATCH_SIZE,
			handler: async (abs) => {
				const leaseOk = await renewLease(lease, leaseMs)
				if (!leaseOk) return false

				const isHtml = abs.endsWith('.html')
				const key = manifestKey(abs)
				const currentRevision = manifestMap.get(key) ?? null
				const previousRevision = previousMap.get(key) ?? null

				if (isHtml) {
					const cached = await matchCache(PAGES_CACHE, abs)
					const shouldFetch = shouldFetchWithRevision({
						cached,
						currentRevision,
						previousRevision
					})
					if (!shouldFetch) return true

					let res
					try {
						res = await fetch(abs)
					} catch {
						return false
					}
					if (!res || res.status !== 200) return false
					const ok = await putCache(PAGES_CACHE, abs, res)
					if (!ok) return false
				} else {
					const cached = await matchCache(ASSETS_CACHE, abs)
					const shouldFetch = shouldFetchWithRevision({
						cached,
						currentRevision,
						previousRevision
					})
					if (!shouldFetch) return true

					let res
					try {
						res = await fetch(abs)
					} catch {
						return false
					}
					if (!res || res.status !== 200) return false
					const ok = await putCache(ASSETS_CACHE, abs, res)
					if (!ok) return false
				}

				return true
			}
		})

		if (failedIndex !== null) {
			await idbSet(KEY_INDEX, startIndex + failedIndex)
			return
		}

		await idbSet(KEY_INDEX, -1) // done
		completed = true
	} finally {
		if (completed) {
			await idbSet(KEY_MANIFEST, getManifestEntries())
			await idbSet(KEY_FORCE, 0)
		}
		await releaseLease(lease)
	}
}

self.addEventListener('message', (event) => {
	if (event.data?.type !== 'METHANOL_WARM_MANIFEST') return
	event.waitUntil(warmManifestResumable())
})
