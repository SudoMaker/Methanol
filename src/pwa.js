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

import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import fg from 'fast-glob'
import picomatch from 'picomatch'
import { normalizePath } from 'vite'
import { state } from './state.js'
import { resolveBasePrefix } from './config.js'

const DEFAULT_PRECACHE = {
	include: ['**/*.{html,js,css,ico,png,svg,webp,jpg,jpeg,gif,woff,woff2,ttf}'],
	exclude: ['**/*.map', '**/pagefind/**'],
	priority: null,
	limit: null,
	batchSize: null
}

const DEFAULT_INSTALL_PRIORITY_MAX = 2
const TEXT_EXTS = new Set([
	'.css',
	'.js',
	'.mjs',
	'.json',
	'.txt',
	'.xml',
	'.webmanifest'
])
const BINARY_EXTS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.avif',
	'.svg',
	'.ico',
	'.bmp',
	'.woff',
	'.woff2',
	'.ttf',
	'.otf',
	'.eot',
	'.mp3',
	'.wav',
	'.ogg',
	'.mp4',
	'.webm',
	'.pdf'
])

const normalizeList = (value, fallback) => {
	if (Array.isArray(value)) return value.filter(Boolean)
	if (typeof value === 'string') return [value]
	return fallback
}

export const resolvePwaOptions = (input) => {
	if (input === true) {
		return { enabled: true, options: { precache: { ...DEFAULT_PRECACHE } } }
	}
	if (input && typeof input === 'object') {
		const precache = resolvePrecacheOptions(input.precache)
		return { enabled: true, options: { ...input, precache } }
	}
	if (input === false) {
		return { enabled: false, options: null }
	}
	return { enabled: false, options: null }
}

export const resolvePrecacheOptions = (input) => {
	const precache = input && typeof input === 'object' ? input : {}
	return {
		include: normalizeList(precache.include, DEFAULT_PRECACHE.include),
		exclude: normalizeList(precache.exclude, DEFAULT_PRECACHE.exclude),
		priority: Array.isArray(precache.priority) ? precache.priority : DEFAULT_PRECACHE.priority,
		limit: Number.isFinite(precache.limit) && precache.limit >= 0 ? precache.limit : null,
		batchSize: Number.isFinite(precache.batchSize) ? precache.batchSize : null
	}
}

const hashMd5 = (value) => createHash('md5').update(value).digest('hex')

const joinBase = (prefix, value) => {
	if (!prefix) return value
	if (value.startsWith(prefix)) return value
	return `${prefix}${value}`
}

const isRootOrAssets = (relativePath) => {
	if (relativePath.startsWith('assets/')) return true
	return !relativePath.includes('/')
}

const getExtension = (relativePath) => {
	const index = relativePath.lastIndexOf('.')
	if (index === -1) return ''
	return relativePath.slice(index).toLowerCase()
}

const isTextAsset = (relativePath) => TEXT_EXTS.has(getExtension(relativePath))
const isBinaryAsset = (relativePath) => BINARY_EXTS.has(getExtension(relativePath))

const resolveDefaultPriority = (relativePath) => {
	const lower = relativePath.toLowerCase()
	if (lower === 'offline.html' || lower === '404.html') return 0
	if (relativePath.startsWith('assets/') && isTextAsset(relativePath)) return 0
	if (lower.endsWith('.html')) return 1
	if (isBinaryAsset(relativePath)) return 3
	if (isTextAsset(relativePath)) return 2
	if (isRootOrAssets(relativePath)) return 2
	return 3
}

const resolvePriorityBuckets = (priority) => {
	if (!Array.isArray(priority) || priority.length === 0) return null
	const buckets = []
	for (const entry of priority) {
		if (typeof entry === 'function') {
			buckets.push(entry)
			continue
		}
		if (typeof entry === 'string' || Array.isArray(entry)) {
			const matcher = picomatch(entry)
			buckets.push((item) => matcher(item.path))
			continue
		}
		if (entry && typeof entry === 'object') {
			if (typeof entry.test === 'function') {
				buckets.push(entry.test)
				continue
			}
			const match = entry.match || entry.include
			if (typeof match === 'string' || Array.isArray(match)) {
				const matcher = picomatch(match)
				buckets.push((item) => matcher(item.path))
			}
		}
	}
	return buckets.length ? buckets : null
}

const resolvePriority = (relativePath, buckets) => {
	if (!buckets || !buckets.length) return resolveDefaultPriority(relativePath)
	const item = { path: relativePath }
	for (let i = 0; i < buckets.length; i += 1) {
		try {
			if (buckets[i](item)) return i
		} catch {}
	}
	return buckets.length
}

export const writeWebManifest = async ({ distDir, options }) => {
	if (!options) return null
	const manifest = {
		name: state.SITE_NAME,
		short_name: state.SITE_NAME,
		...(options.manifest || {})
	}
	const outPath = resolve(distDir, 'manifest.webmanifest')
	await writeFile(outPath, JSON.stringify(manifest, null, 2))
	return outPath
}

export const buildPrecacheManifest = async ({ distDir, options }) => {
	if (!options) return null
	const precache = resolvePrecacheOptions(options.precache)
	const basePrefix = resolveBasePrefix()
	const buckets = resolvePriorityBuckets(precache.priority)
	const files = (await fg(precache.include, {
		cwd: distDir,
		onlyFiles: true,
		dot: false,
		ignore: precache.exclude
	})).filter((file) => normalizePath(file) !== 'precache-manifest.json')
	const entries = []
	for (const file of files.sort()) {
		const normalized = normalizePath(file)
		const fsPath = resolve(distDir, file)
		if (!existsSync(fsPath)) continue
		const content = await readFile(fsPath)
		const revision = hashMd5(content)
		const url = joinBase(basePrefix, `/${normalized}`)
		const priority = resolvePriority(normalized, buckets)
		entries.push({ url, revision, priority })
	}
	entries.sort((a, b) => {
		if (a.priority !== b.priority) return a.priority - b.priority
		return a.url.localeCompare(b.url)
	})
	if (precache.limit && entries.length > precache.limit) {
		entries.length = precache.limit
	}
	const installCount = entries.filter((entry) => entry.priority <= DEFAULT_INSTALL_PRIORITY_MAX).length
	const manifestBody = {
		entries: entries.map(({ url, revision }) => ({ url, revision })),
		installCount,
		batchSize: precache.batchSize
	}
	const manifestHash = hashMd5(JSON.stringify(manifestBody))
	const manifest = { ...manifestBody, hash: manifestHash }
	const manifestPath = resolve(distDir, 'precache-manifest.json')
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
	return { manifestPath, manifestHash }
}

export const patchServiceWorker = async ({ distDir, manifestHash }) => {
	if (!manifestHash) return false
	const swPath = resolve(distDir, 'sw.js')
	if (!existsSync(swPath)) return false
	const raw = await readFile(swPath, 'utf-8')
	if (!raw.includes('__METHANOL_MANIFEST_HASH__')) return false
	const next = raw.replace(/__METHANOL_MANIFEST_HASH__/g, manifestHash)
	if (next !== raw) {
		await writeFile(swPath, next)
	}
	return true
}
