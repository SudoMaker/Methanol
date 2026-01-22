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

import { cached, cachedStr } from '../utils.js'
import { normalizeBasePrefix } from '../base.js'

const MANIFEST_HASH = '__METHANOL_MANIFEST_HASH__'
const DEFAULT_BATCH_SIZE = 5
const REVISION_HEADER = 'X-Methanol-Revision'

self.skipWaiting()

const resolveBasePrefix = cached(() => normalizeBasePrefix(import.meta.env?.BASE_URL || '/'))

const withBase = cachedStr((path) => {
	const prefix = resolveBasePrefix()
	if (!prefix || path.startsWith(`${prefix}/`)) return path
	return `${prefix}${path}`
})

const MANIFEST_URL = withBase('/precache-manifest.json')

const NOT_FOUND_URL = new URL(withBase('/404.html'), self.location.origin).href.toLowerCase()
const OFFLINE_FALLBACK_URL = new URL(withBase('/offline.html'), self.location.origin).href.toLowerCase()

const PAGES_CACHE = withBase(':methanol-pages-swr')
const ASSETS_CACHE = withBase(':methanol-assets-swr')


let manifestCache = null
let manifestPromise = null
let manifestIndexCache = null
let manifestIndexPromise = null

const resolveManifestUrl = () => {
	if (!MANIFEST_HASH || MANIFEST_HASH === '__METHANOL_MANIFEST_HASH__') return MANIFEST_URL
	return `${MANIFEST_URL}?v=${MANIFEST_HASH}`
}

async function loadManifest(force = false) {
	if (manifestCache && !force) return manifestCache
	if (manifestPromise && !force) return manifestPromise
	manifestPromise = (async () => {
		if (!force) {
			const cached = await idbGet(KEY_MANIFEST_DATA).catch(() => null)
			if (cached && cached.entries) {
				if (!cached.hash || cached.hash === MANIFEST_HASH) {
					manifestCache = cached
					manifestIndexCache = null
					manifestIndexPromise = null
					return cached
				}
			}
		}
		try {
			const url = new URL(resolveManifestUrl(), self.location.origin).toString()
			const res = await fetch(url, { cache: 'no-store' })
			if (!res || !res.ok) {
				throw new Error('manifest fetch failed')
			}
			const data = await res.json()
			const entries = Array.isArray(data?.entries) ? data.entries : []
			const normalized = entries
				.filter((entry) => entry && entry.url)
				.map((entry) => ({
					url: new URL(entry.url, self.location.href).toString(),
					revision: entry.revision ?? null
				}))
			const installCount = Number.isFinite(data?.installCount)
				? Math.max(0, Math.min(normalized.length, data.installCount))
				: normalized.length
			const batchSize = Number.isFinite(data?.batchSize) ? data.batchSize : DEFAULT_BATCH_SIZE
			const result = { entries: normalized, installCount, batchSize, hash: data?.hash || '' }
			manifestCache = result
			manifestIndexCache = null
			manifestIndexPromise = null
			await idbSet(KEY_MANIFEST_DATA, result).catch(() => {})
			return result
		} catch (error) {
			if (manifestCache) return manifestCache
			throw error
		} finally {
			manifestPromise = null
		}
	})()
	return manifestPromise
}

async function getManifestEntries() {
	const data = await loadManifest()
	return data.entries
}

async function getManifestIndex() {
	if (manifestIndexCache) return manifestIndexCache
	if (manifestIndexPromise) return manifestIndexPromise
	manifestIndexPromise = (async () => {
		const map = new Map()
		const entries = await getManifestEntries()
		for (const entry of entries) {
			map.set(manifestKey(entry.url), entry.revision ?? null)
		}
		manifestIndexCache = map
		manifestIndexPromise = null
		return map
	})()
	return manifestIndexPromise
}

// Precache prioritized entries during install
self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			try {
				const prevHash = await idbGet(KEY_MANIFEST)
				const swChanged = prevHash !== MANIFEST_HASH
				if (swChanged) {
					await idbSet(KEY_FORCE, 1)
					await idbSet(KEY_INDEX, 0)
					await idbSet(KEY_MANIFEST, MANIFEST_HASH)
					await idbSet(KEY_MANIFEST_DATA, null)
				}
				const manifest = await loadManifest(swChanged)
				await installManifest(manifest)
			} catch (error) {
				throw error
			}
		})()
	)
})

async function installManifest(manifest) {
	const pageCache = await openCache(PAGES_CACHE)
	const assetCache = await openCache(ASSETS_CACHE)
	const manifestEntries = manifest.entries
	const manifestMap = buildManifestMap(manifestEntries)
	const installCount = manifest.installCount ?? manifestEntries.length
	const installUrls = manifestEntries.slice(0, installCount).map((entry) => entry.url)
	const batchSize = Math.max(1, manifest.batchSize || DEFAULT_BATCH_SIZE)
	const { failedIndex } = await runConcurrentQueue(installUrls, {
		concurrency: batchSize,
		handler: async (url) => {
			const isHtml = url.endsWith('.html')
			const cacheName = isHtml ? PAGES_CACHE : ASSETS_CACHE
			const cached = await matchCache(cacheName, url)
			const key = manifestKey(url)
			const currentRevision = manifestMap.get(key) ?? null
			const shouldFetch = shouldFetchWithRevision({
				cached,
				currentRevision
			})
			if (!shouldFetch) return true
			const cache = isHtml ? pageCache : assetCache
			return fetchAndCache(cache, url, currentRevision)
		}
	})
	if (failedIndex !== null) {
		throw new Error('install cache failed')
	}
}

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			await self.clients.claim()
			await warmManifestResumable()
		})()
	)
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

function shouldFetchWithRevision({ cached, currentRevision }) {
	if (!cached) return true
	if (currentRevision == null) return false
	const cachedRevision = cached.headers?.get?.(REVISION_HEADER)
	if (cachedRevision == null) return true
	return cachedRevision !== String(currentRevision)
}

function shouldRevalidateCached(cached, currentRevision) {
	if (!cached) return true
	if (currentRevision == null) return false
	const cachedRevision = cached.headers?.get?.(REVISION_HEADER)
	if (cachedRevision == null) return true
	return cachedRevision !== String(currentRevision)
}

async function bufferResponse(response, revision = null) {
	const body = await response.clone().arrayBuffer()
	const headers = new Headers(response.headers)
	if (revision != null) {
		headers.set(REVISION_HEADER, String(revision))
	}
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers
	})
}

async function fetchAndCache(cache, urlString, revision = null) {
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
		buffered = await bufferResponse(res, revision)
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

async function putCache(cacheName, urlString, response, revision = null) {
	const cache = await openCache(cacheName)
	const keyUrl = stripSearch(urlString).toString()
	let toCache = response
	if (cacheName === PAGES_CACHE || cacheName === ASSETS_CACHE) {
		try {
			toCache = await bufferResponse(response, revision)
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

const handleNavigationRequest = async (event, request, index) => {
	const normalizedKey = normalizeNavigationURL(new URL(request.url)).toString()
	const key = manifestKey(normalizedKey)
	const manifestRevision = index.get(key) ?? null
	const inManifest = index.has(key)

	if (inManifest) {
		const cached = await matchCache(PAGES_CACHE, normalizedKey)
		const shouldRevalidate = shouldRevalidateCached(cached, manifestRevision)
		if (cached && !shouldRevalidate) return cached
		if (cached && shouldRevalidate) {
			const fresh = await fetchWithCleanUrlFallback(event, request, {
				usePreload: isHtmlNavigation(request),
				allowNotOk: true
			})
			if (fresh && fresh.status === 200) {
				await putCache(PAGES_CACHE, normalizedKey, fresh.clone(), manifestRevision)
				return fresh
			}
			if (fresh && fresh.status === 404) {
				return serveNotFound()
			}
			if (fresh) return fresh
			return cached
		}
	}

	const fresh = await fetchWithCleanUrlFallback(event, request, {
		usePreload: isHtmlNavigation(request),
		allowNotOk: true
	})
	if (fresh && fresh.status === 200) {
		if (inManifest) {
			await putCache(PAGES_CACHE, normalizedKey, fresh.clone(), manifestRevision)
		}
		return fresh
	}
	if (fresh && fresh.status === 404) {
		return serveNotFound()
	}

	if (fresh) return fresh

	return serveOffline()
}

const handleAssetRequest = async (request, index) => {
	const key = manifestKey(request.url)
	const manifestRevision = index.get(key) ?? null
	const cached = await matchCache(ASSETS_CACHE, key)
	const shouldRevalidate = shouldRevalidateCached(cached, manifestRevision)
	if (cached && !shouldRevalidate) return cached

	try {
		const res = await fetch(request)
		if (res && res.status === 200) {
			await putCache(ASSETS_CACHE, key, res.clone(), manifestRevision)
		}
		return res
	} catch {
		if (cached) return cached
		return new Response(null, { status: 503 })
	}
}

self.addEventListener('fetch', (event) => {
	const request = event.request
	if (!request || request.method !== 'GET') return
	let url = null
	try {
		url = new URL(request.url)
	} catch {
		return
	}
	if (url.origin !== self.location.origin) return

	event.respondWith(
		(async () => {
			try {
				const manifestKeyUrl = stripSearch(new URL(MANIFEST_URL, self.location.origin).toString()).toString()
				if (stripSearch(request.url).toString() === manifestKeyUrl) {
					return fetch(request)
				}
				if (isHtmlNavigation(request) || isPrefetch(request)) {
					const index = await getManifestIndex().catch(() => new Map())
					return await handleNavigationRequest(event, request, index)
				}
				const index = await getManifestIndex().catch(() => new Map())
				if (
					request.destination !== 'document' &&
					!isHtmlNavigation(request) &&
					index.has(manifestKey(request.url))
				) {
					return await handleAssetRequest(request, index)
				}
			} catch {}
			return fetch(request)
		})()
	)
})

const DB_NAME = withBase(':methanol-pwa-warm-db')
const DB_STORE = 'kv'
const KEY_INDEX = 'warmIndex'
const KEY_LEASE = 'warmLease'
const KEY_FORCE = 'warmForce'
const KEY_MANIFEST = 'warmManifestHash'
const KEY_MANIFEST_DATA = 'warmManifestData'

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
	let manifest = null
	try {
		manifest = await loadManifest()
	} catch {
		return
	}

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
		const manifestEntries = manifest.entries
		const manifestMap = buildManifestMap(manifestEntries)
		const urls = manifestEntries.slice(manifest.installCount).map((entry) => entry.url)
		if (!urls.length) return
		if (index >= urls.length) {
			completed = true
			return
		}

		const startIndex = index
		const { failedIndex } = await runConcurrentQueue(urls.slice(startIndex), {
			concurrency: Math.max(1, manifest.batchSize || DEFAULT_BATCH_SIZE),
			handler: async (abs) => {
				const leaseOk = await renewLease(lease, leaseMs)
				if (!leaseOk) return false

				const isHtml = abs.endsWith('.html')
				const key = manifestKey(abs)
				const currentRevision = manifestMap.get(key) ?? null

				if (isHtml) {
					const cached = await matchCache(PAGES_CACHE, abs)
					const shouldFetch = shouldFetchWithRevision({
						cached,
						currentRevision
					})
					if (!shouldFetch) return true

					let res
					try {
						res = await fetch(abs)
					} catch {
						return false
					}
					if (!res || res.status !== 200) return false
					const ok = await putCache(PAGES_CACHE, abs, res, currentRevision)
					if (!ok) return false
				} else {
					const cached = await matchCache(ASSETS_CACHE, abs)
					const shouldFetch = shouldFetchWithRevision({
						cached,
						currentRevision
					})
					if (!shouldFetch) return true

					let res
					try {
						res = await fetch(abs)
					} catch {
						return false
					}
					if (!res || res.status !== 200) return false
					const ok = await putCache(ASSETS_CACHE, abs, res, currentRevision)
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
			await idbSet(KEY_FORCE, 0)
		}
		await releaseLease(lease)
	}
}

self.addEventListener('message', (event) => {
	if (event.data?.type !== 'METHANOL_WARM_MANIFEST') return
	warmManifestResumable()
})
