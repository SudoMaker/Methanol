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
import { existsSync, readFileSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { state } from './state.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FORMAT = 1
const SOURCE_LINK_PATTERN = /(?:^|[\s"'(<>=])((?:\.{1,2}\/)?[^<>"'()\s?#]+?\.(?:mdx?|html))(?=[?#<>"'()\s]|$)/gim
const memoryCache = new Map()

const hash = (value) => createHash('sha256').update(value).digest('hex')

const compilerRevision = (() => {
	const paths = [
		resolve(__dirname, 'mdx.js'),
		resolve(__dirname, 'rehype-plugins/link-resolve.js'),
		resolve(__dirname, 'rehype-plugins/methanol-ctx.js'),
		resolve(__dirname, '../package.json')
	]
	const digest = createHash('sha256')
	for (const path of paths) {
		try {
			digest.update(readFileSync(path))
		} catch {
			return 'unknown'
		}
	}
	return digest.digest('hex')
})()

const stableSerialize = (value, seen = new Set()) => {
	if (value == null || typeof value === 'string' || typeof value === 'boolean') {
		return JSON.stringify(value)
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? String(value) : JSON.stringify(String(value))
	}
	if (typeof value === 'bigint') return JSON.stringify(`${value}n`)
	if (typeof value === 'function') return JSON.stringify(value.toString())
	if (value instanceof Date) return JSON.stringify(value.toISOString())
	if (value instanceof RegExp) return JSON.stringify(value.toString())
	if (seen.has(value)) return '"[Circular]"'
	seen.add(value)
	let result
	if (Array.isArray(value)) {
		result = `[${value.map((item) => stableSerialize(item, seen)).join(',')}]`
	} else {
		result = `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`)
			.join(',')}}`
	}
	seen.delete(value)
	return result
}

const isWithinRoot = (root, targetPath) => {
	if (!root) return false
	const relPath = relative(root, targetPath)
	return relPath === '' || (!relPath.startsWith('..') && !isAbsolute(relPath))
}

const resolvePageRoot = (path) => {
	const roots = [state.PAGES_DIR, state.THEME_PAGES_DIR].filter(Boolean).map((root) => resolve(root))
	const sourcePath = resolve(path)
	return roots.find((root) => isWithinRoot(root, sourcePath)) || roots[0] || null
}

const resolveLinkSignature = (content, path) => {
	const sourceDir = dirname(path)
	const pageRoot = resolvePageRoot(path)
	const links = new Set()
	SOURCE_LINK_PATTERN.lastIndex = 0
	let match
	while ((match = SOURCE_LINK_PATTERN.exec(content))) {
		const href = match[1]
		if (!href || href.startsWith('/') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) continue
		links.add(href)
	}
	return Array.from(links)
		.sort()
		.map((href) => {
			const extension = href.match(/\.(mdx?|html)$/i)?.[0]
			const stem = extension ? href.slice(0, -extension.length) : href
			const candidates = /\.html$/i.test(extension)
				? [`${stem}.html`, `${stem}.md`, `${stem}.mdx`]
				: [href]
			return [
				href,
				...candidates.map((candidate) => {
					const target = resolve(sourceDir, candidate)
					return pageRoot && isWithinRoot(pageRoot, target) && existsSync(target)
				})
			]
		})
}

const canPersist = () =>
	state.PAGES_DIR &&
	state.USER_MDX_CONFIG == null &&
	state.USER_THEME?.mdx == null &&
	state.STARRY_NIGHT_OPTIONS == null

const createCacheRecord = ({ content, path, frontmatter }) => {
	const development = state.CURRENT_MODE !== 'production'
	const key = hash(
		stableSerialize({
			format: CACHE_FORMAT,
			compilerRevision,
			development,
			path: resolve(path),
			content,
			frontmatter,
			gfm: state.GFM_ENABLED,
			starryNight: state.STARRY_NIGHT_ENABLED,
			links: resolveLinkSignature(content, path)
		})
	)
	const name = hash(`${development ? 'development' : 'production'}\0${resolve(path)}`).slice(0, 32)
	const cachePath = resolve(state.PAGES_DIR, '.methanol/cache/mdx', `${name}.json`)
	return { key, cachePath, development }
}

export const readCompiledMdxCache = async (input) => {
	const record = createCacheRecord(input)
	const cached = memoryCache.get(record.key)
	if (cached) return { record, result: cached }
	if (!canPersist()) return { record, result: null }
	try {
		const stored = JSON.parse(await readFile(record.cachePath, 'utf8'))
		if (stored?.key !== record.key || typeof stored.code !== 'string') {
			return { record, result: null }
		}
		const result = { code: stored.code, development: Boolean(stored.development) }
		memoryCache.set(record.key, result)
		return { record, result }
	} catch {
		return { record, result: null }
	}
}

export const writeCompiledMdxCache = async (record, result) => {
	memoryCache.set(record.key, result)
	if (!canPersist()) return
	try {
		await mkdir(dirname(record.cachePath), { recursive: true })
		await writeFile(
			record.cachePath,
			JSON.stringify({
				key: record.key,
				code: result.code,
				development: result.development
			})
		)
	} catch {
		// Cache failures must never fail a build.
	}
}
