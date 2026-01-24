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

import matter from 'gray-matter'
import { readdir, readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve, join, relative } from 'path'
import { cpus } from 'os'
import { Worker } from 'worker_threads'
import { state, cli } from './state.js'
import { withBase } from './config.js'
import { compileMdxSource, compilePageMdx } from './mdx.js'
import { createStageLogger } from './stage-logger.js'

const isPageFile = (name) => name.endsWith('.mdx') || name.endsWith('.md')
const isIgnoredEntry = (name) => name.startsWith('.') || name.startsWith('_')

const pageMetadataCache = new Map()
const pageDerivedCache = new Map()
const MDX_WORKER_URL = new URL('./workers/entry-mdx-compile-worker.js', import.meta.url)
const cliOverrides = {
	CLI_INTERMEDIATE_DIR: cli.CLI_INTERMEDIATE_DIR,
	CLI_EMIT_INTERMEDIATE: cli.CLI_EMIT_INTERMEDIATE,
	CLI_HOST: cli.CLI_HOST,
	CLI_PORT: cli.CLI_PORT,
	CLI_PAGES_DIR: cli.CLI_PAGES_DIR,
	CLI_COMPONENTS_DIR: cli.CLI_COMPONENTS_DIR,
	CLI_ASSETS_DIR: cli.CLI_ASSETS_DIR,
	CLI_OUTPUT_DIR: cli.CLI_OUTPUT_DIR,
	CLI_CONFIG_PATH: cli.CLI_CONFIG_PATH,
	CLI_SITE_NAME: cli.CLI_SITE_NAME,
	CLI_OWNER: cli.CLI_OWNER,
	CLI_CODE_HIGHLIGHTING: cli.CLI_CODE_HIGHLIGHTING,
	CLI_JOBS: cli.CLI_JOBS,
	CLI_VERBOSE: cli.CLI_VERBOSE,
	CLI_BASE: cli.CLI_BASE,
	CLI_SEARCH: cli.CLI_SEARCH,
	CLI_THEME: cli.CLI_THEME,
	CLI_RSS: cli.CLI_RSS,
	CLI_ATOM: cli.CLI_ATOM,
	CLI_PWA: cli.CLI_PWA
}

const resolveWorkerCount = (total) => {
	const cpuCount = Math.max(1, cpus()?.length || 1)
	const requested = state.WORKER_JOBS
	if (requested == null || requested <= 0) {
		const items = Math.max(1, Number.isFinite(total) ? total : 1)
		const autoCount = Math.round(Math.log(items))
		return Math.max(1, Math.min(cpuCount, autoCount))
	}
	return Math.max(1, Math.min(cpuCount, Math.floor(requested)))
}

const compileMdxSources = async (pages, options = {}) => {
	const targets = pages.filter((page) => page && page.content != null && !page.mdxComponent)
	const results = new Map()
	if (!targets.length) return results
	const { onProgress } = options || {}
	const reportProgress = (page) => {
		if (typeof onProgress === 'function') {
			onProgress(page)
		}
	}
	const workerCount = Math.min(resolveWorkerCount(targets.length), targets.length)
	if (workerCount <= 1) {
		for (const page of targets) {
			const result = await compileMdxSource({
				content: page.content,
				path: page.path,
				frontmatter: page.frontmatter
			})
			results.set(page, result)
			reportProgress(page)
		}
		return results
	}

	return await new Promise((resolve, reject) => {
		const workers = []
		const pending = new Map()
		let cursor = 0
		let nextId = 0
		let finished = false

		const finalize = async (error) => {
			if (finished) return
			finished = true
			await Promise.all(workers.map((worker) => worker.terminate().catch(() => null)))
			if (error) {
				reject(error)
				return
			}
			resolve(results)
		}

		const assign = (worker) => {
			if (cursor >= targets.length) return false
			const page = targets[cursor++]
			const id = nextId++
			pending.set(id, page)
			worker.postMessage({
				id,
				path: page.path,
				content: page.content,
				frontmatter: page.frontmatter
			})
			return true
		}

		const handleMessage = (worker, message) => {
			if (finished) return
			const { id, result, error } = message || {}
			const page = pending.get(id)
			pending.delete(id)
			if (!page) return
			if (error) {
				void finalize(new Error(error))
				return
			}
			results.set(page, result)
			reportProgress(page)
			assign(worker)
			if (results.size === targets.length && pending.size === 0) {
				void finalize()
			}
		}

		const handleError = (error) => {
			if (finished) return
			void finalize(error instanceof Error ? error : new Error(String(error)))
		}

		for (let i = 0; i < workerCount; i += 1) {
			const worker = new Worker(MDX_WORKER_URL, {
				type: 'module',
				workerData: {
					mode: state.CURRENT_MODE,
					configPath: cli.CLI_CONFIG_PATH,
					cli: cliOverrides
				}
			})
			workers.push(worker)
			worker.on('message', (message) => handleMessage(worker, message))
			worker.on('error', handleError)
			worker.on('exit', (code) => {
				if (code !== 0) {
					handleError(new Error(`MDX worker exited with code ${code}`))
				}
			})
			assign(worker)
		}
	})
}

const collectLanguagesFromPages = (pages = []) => {
	const languages = new Map()
	for (const page of pages) {
		if (!page.isIndex) continue
		const label = page.frontmatter?.lang
		if (label == null || label === '') continue
		const routePath = page.routePath || '/'
		const frontmatterCode = page.frontmatter?.langCode
		const code =
			typeof frontmatterCode === 'string' && frontmatterCode.trim()
				? frontmatterCode.trim()
				: routePath === '/'
					? null
					: routePath.replace(/^\/+/, '')
		languages.set(routePath, {
			routePath,
			routeHref: withBase(routePath),
			label: String(label),
			code: code || null
		})
	}
	return Array.from(languages.values()).sort((a, b) => a.routePath.localeCompare(b.routePath))
}

const normalizeRoutePath = (value) => {
	if (!value) return '/'
	let normalized = value
	if (!normalized.startsWith('/')) {
		normalized = `/${normalized}`
	}
	normalized = normalized.replace(/\/{2,}/g, '/')
	if (normalized === '/') return '/'
	if (normalized.endsWith('/')) {
		return normalized.replace(/\/+$/, '/')
	}
	return normalized
}

const stripTrailingSlash = (value) => {
	if (!value || value === '/') return '/'
	return value.replace(/\/+$/, '')
}

const toRoutePrefix = (value) => {
	const normalized = normalizeRoutePath(value)
	const stripped = stripTrailingSlash(normalized)
	return stripped === '/' ? '' : stripped
}

const resolveLanguageForRoute = (languages = [], routePath = '/') => {
	if (!languages.length) return null
	const normalizedRoute = normalizeRoutePath(routePath)
	let best = null
	let bestLength = -1
	let rootLanguage = null
	for (const lang of languages) {
		const base = normalizeRoutePath(lang.routePath)
		const basePrefix = toRoutePrefix(base)
		if (!base) continue
		if (base === '/') {
			rootLanguage = lang
			continue
		}
		if (normalizedRoute === base || (basePrefix && normalizedRoute.startsWith(`${basePrefix}/`))) {
			if (basePrefix.length > bestLength) {
				best = lang
				bestLength = basePrefix.length
			}
		}
	}
	return best || rootLanguage
}

export const routePathFromFile = (path, pagesDir = state.PAGES_DIR) => {
	if (!path.endsWith('.mdx') && !path.endsWith('.md')) {
		return null
	}
	const relPath = relative(pagesDir, path)
	if (relPath.startsWith('..')) {
		return null
	}
	const name = relPath.replace(/\.(mdx|md)$/, '')
	const baseName = name.split(/[\\/]/).pop()
	if (isIgnoredEntry(baseName)) {
		return null
	}
	const normalized = name.replace(/\\/g, '/')
	if (normalized === 'index') {
		return '/'
	}
	if (normalized.endsWith('/index')) {
		return `/${normalized.slice(0, -'/index'.length)}/`
	}
	return `/${normalized}`
}

const parseFrontmatter = (raw) => {
	const parsed = matter(raw)
	const data = { ...(parsed.data || {}) }
	if (data.excerpt == null && data.description != null) {
		data.excerpt = data.description
	}
	if (data.description == null && data.excerpt != null) {
		data.description = data.excerpt
	}
	const content = parsed.content ?? ''
	return {
		data,
		content,
		matter: parsed.matter ?? null
	}
}

const parsePageMetadata = async (path) => {
	const raw = await readFile(path, 'utf-8')
	const { data: frontmatter, content, matter } = parseFrontmatter(raw)
	let title = frontmatter.title
	return {
		raw,
		content,
		frontmatter,
		matter,
		title
	}
}

const parseWeight = (value) => {
	if (value == null || value === '') return null
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : null
}

const parseDate = (value) => {
	if (!value) return null
	const date = new Date(value)
	return Number.isNaN(date.valueOf()) ? null : date.toISOString()
}

const stripRootPrefix = (value, rootDir) => {
	if (!rootDir || !value) return value
	if (value === rootDir) return ''
	if (value.startsWith(`${rootDir}/`)) {
		return value.slice(rootDir.length + 1)
	}
	return value
}

const buildPagesTree = (pages, options = {}) => {
	const rootPath = normalizeRoutePath(options.rootPath || '/')
	const rootPrefix = toRoutePrefix(rootPath)
	const rootDir = rootPrefix ? rootPrefix.replace(/^\/+/, '') : ''
	const includeHiddenRoot = Boolean(options.includeHiddenRoot)
	const currentRoutePath = normalizeRoutePath(options.currentRoutePath || '/')
	const rootSegments = rootDir ? rootDir.split('/') : []
	const resolveRouteWithinRoot = (routePath) => {
		if (!routePath) return '/'
		if (!rootDir) return routePath
		if (routePath === rootPath) return '/'
		if (rootPrefix && routePath.startsWith(`${rootPrefix}/`)) {
			const stripped = routePath.slice(rootPrefix.length)
			return stripped.startsWith('/') ? stripped : `/${stripped}`
		}
		return routePath
	}
	const buildDirRoutePath = (dir) => {
		const localPath = dir ? `/${dir}/` : '/'
		if (!rootPrefix) return normalizeRoutePath(localPath)
		return normalizeRoutePath(`${rootPrefix}${localPath}`)
	}
	const resolveDirFsPath = (dir) => {
		if (!rootDir) return resolve(state.PAGES_DIR, dir)
		return resolve(state.PAGES_DIR, join(rootDir, dir))
	}
	const currentRouteWithinRoot = resolveRouteWithinRoot(currentRoutePath)
	const isUnderRoot = (page) => {
		if (!rootDir) return true
		return page.routePath === rootPath || (rootPrefix && page.routePath.startsWith(`${rootPrefix}/`))
	}
	const treePages = pages
		.filter((page) => isUnderRoot(page))
		.map((page) => {
			const originalDir = page.dir
			if (!rootDir) return { ...page, originalDir }
			const relativePath = stripRootPrefix(page.relativePath, rootDir)
			const dir = stripRootPrefix(page.dir, rootDir)
			const segments = page.segments.slice(rootSegments.length)
			const depth = segments.length
			return {
				...page,
				originalDir,
				relativePath,
				dir,
				segments,
				depth
			}
		})
	const root = []
	const dirs = new Map()
	const getDirNode = (path, name, depth) => {
		if (dirs.has(path)) return dirs.get(path)
		const dir = {
			type: 'directory',
			name,
			path: resolveDirFsPath(path),
			children: [],
			depth,
			routePath: buildDirRoutePath(path),
			routeHref: null,
			title: null,
			weight: null,
			date: null,
			isRoot: false,
			hidden: false,
			hiddenByFrontmatter: false
		}
		dirs.set(path, dir)
		return dir
	}
	for (const page of treePages) {
		const isRootIndex = page.isRoot && page.isIndex
		const promoteRoot = rootPath === '/' && isRootIndex && page.routePath !== '/'
		const parts = page.relativePath.split('/')
		parts.pop()
		let cursor = root
		let currentPath = ''
		if (!promoteRoot) {
			for (const part of parts) {
				currentPath = currentPath ? `${currentPath}/${part}` : part
				const dir = getDirNode(currentPath, part, currentPath.split('/').length)
				if (!cursor.includes(dir)) {
					cursor.push(dir)
				}
				cursor = dir.children
			}
		}
		const dirPath = page.dir || ''
		if (page.isIndex && dirPath && !page.isRoot) {
			const dir = getDirNode(dirPath, dirPath.split('/').pop() || '', dirPath ? dirPath.split('/').length : 0)
			dir.routePath = page.routePath
			dir.routeHref = page.routeHref
			dir.title = page.title
			dir.weight = page.weight ?? null
			dir.date = page.date ?? null
			dir.isRoot = page.isRoot || false
			dir.hidden = page.hidden || false
			dir.hiddenByFrontmatter = page.hiddenByFrontmatter || false
			dir.page = page
			continue
		}
		cursor.push({
			type: 'page',
			...page
		})
	}
	const compareNodes = (a, b, level = 0) => {
		if (a?.routePath === '/' && b?.routePath !== '/') return -1
		if (b?.routePath === '/' && a?.routePath !== '/') return 1
		if (a?.isIndex && !b?.isIndex) return -1
		if (b?.isIndex && !a?.isIndex) return 1
		if (level === 0 && a?.type !== b?.type) {
			return a.type === 'page' ? -1 : 1
		}
		const weightA = Number.isFinite(a.weight) ? a.weight : null
		const weightB = Number.isFinite(b.weight) ? b.weight : null
		if (weightA != null || weightB != null) {
			if (weightA == null) return 1
			if (weightB == null) return -1
			if (weightA !== weightB) return weightA - weightB
		}
		const dateA = a.date ? new Date(a.date).valueOf() : null
		const dateB = b.date ? new Date(b.date).valueOf() : null
		if (dateA != null || dateB != null) {
			if (dateA == null) return 1
			if (dateB == null) return -1
			if (dateA !== dateB) return dateB - dateA
		}
		const labelA = (a.title || a.name || '').toLowerCase()
		const labelB = (b.title || b.name || '').toLowerCase()
		if (labelA < labelB) return -1
		if (labelA > labelB) return 1
		return 0
	}
	const sortTree = (nodes, level = 0) => {
		nodes.sort((a, b) => compareNodes(a, b, level))
		for (const node of nodes) {
			if (node.type === 'directory') {
				sortTree(node.children, level + 1)
			}
		}
	}
	sortTree(root)
	return root
}

const walkPages = async function* (dir, basePath = '') {
	const entries = await readdir(dir)
	const files = []
	const dirs = []

	for (const entry of entries.sort()) {
		if (isIgnoredEntry(entry)) {
			continue
		}
		const fullPath = join(dir, entry)
		const stats = await stat(fullPath)
		if (stats.isDirectory()) {
			dirs.push({ entry, fullPath })
		} else if (isPageFile(entry)) {
			files.push({ entry, fullPath })
		}
	}

	for (const { entry, fullPath } of files) {
		const name = entry.replace(/\.(mdx|md)$/, '')
		const relativePath = join(basePath, name).replace(/\\/g, '/')
		const isIndex = name === 'index'
		const routePath = isIndex ? (basePath ? `/${basePath}/` : '/') : `/${relativePath}`
		yield { routePath, path: fullPath, isIndex }
	}

	for (const { entry, fullPath } of dirs) {
		yield* walkPages(fullPath, join(basePath, entry))
	}
}

export const buildPageEntry = async ({ path, pagesDir, source }) => {
	const routePath = routePathFromFile(path, pagesDir)
	if (!routePath) return null
	const relPath = relative(pagesDir, path).replace(/\\/g, '/')
	const name = relPath.replace(/\.(mdx|md)$/, '')
	const baseName = name.split('/').pop()
	const dir = name.split('/').slice(0, -1).join('/')
	const dirName = dir ? dir.split('/').pop() : ''
	const isIndex = baseName === 'index'
	const segments = routePath.split('/').filter(Boolean)
	const stats = await stat(path)
	const cached = pageMetadataCache.get(path)
	let metadata = null
	if (cached && cached.mtimeMs === stats.mtimeMs) {
		metadata = cached.metadata
	} else {
		metadata = await parsePageMetadata(path)
		pageMetadataCache.set(path, { mtimeMs: stats.mtimeMs, metadata })
	}
	const derived = pageDerivedCache.get(path)
	const exclude = Boolean(metadata.frontmatter?.exclude)
	const frontmatterHidden = metadata.frontmatter?.hidden
	const hiddenByFrontmatter = frontmatterHidden === true
	const isNotFoundPage = routePath === '/404'
	const isOfflinePage = routePath === '/offline'
	const isSpecialPage = isNotFoundPage || isOfflinePage
	const isSiteRoot = routePath === '/'
	const frontmatterIsRoot = Boolean(metadata.frontmatter?.isRoot)
	const hidden =
		frontmatterHidden === false
			? false
			: hiddenByFrontmatter
				? true
				: isSpecialPage
					? true
					: frontmatterIsRoot
	return {
		routePath,
		routeHref: withBase(routePath),
		path,
		source,
		relativePath: relPath,
		name: baseName,
		dir,
		segments,
		depth: segments.length,
		isIndex,
		title: metadata.title || derived?.title || (baseName === 'index' ? (dirName || 'Home') : baseName),
		weight: parseWeight(metadata.frontmatter?.weight),
		date: parseDate(metadata.frontmatter?.date) || parseDate(stats.mtime),
		isRoot: isSiteRoot || frontmatterIsRoot,
		hidden,
		hiddenByFrontmatter,
		exclude,
		content: metadata.content,
		frontmatter: metadata.frontmatter,
		toc: derived?.toc || null,
		matter: metadata.matter ?? null,
		stats: {
			size: stats.size,
			createdAt: stats.birthtime?.toISOString?.() || null,
			updatedAt: stats.mtime?.toISOString?.() || null
		}
	}
}

const collectPagesFromDir = async (pagesDir, source) => {
	if (!pagesDir || !existsSync(pagesDir)) {
		return []
	}
	const pages = []
	for await (const page of walkPages(pagesDir)) {
		const entry = await buildPageEntry({
			path: page.path,
			pagesDir,
			source
		})
		if (entry) {
			entry.isIndex = page.isIndex || entry.isIndex
			pages.push(entry)
		}
	}
	return pages
}

const collectPages = async () => {
	const userPages = await collectPagesFromDir(state.PAGES_DIR, 'user')
	const themePages = state.THEME_PAGES_DIR
		? await collectPagesFromDir(state.THEME_PAGES_DIR, 'theme')
		: []
	const userRoutes = new Set(userPages.map((page) => page.routePath))
	const pages = [...userPages, ...themePages.filter((page) => !userRoutes.has(page.routePath))]
	const excludedDirs = new Set(pages.filter((page) => page.exclude && page.isIndex && page.dir).map((page) => page.dir))
	const isUnderExcludedDir = (dir) => {
		if (!dir) return false
		const parts = dir.split('/')
		for (let i = 1; i <= parts.length; i++) {
			const candidate = parts.slice(0, i).join('/')
			if (excludedDirs.has(candidate)) {
				return true
			}
		}
		return false
	}
	const excludedRoutes = new Set(pages.filter((page) => page.exclude).map((page) => page.routePath))
	const filteredPages = pages.filter((page) => {
		if (page.exclude) return false
		if (isUnderExcludedDir(page.dir)) return false
		return true
	})
	return { pages: filteredPages, excludedRoutes, excludedDirs }
}

const buildIndexFallback = (pages, siteName) => {
	const isSpecialPage = (page) => page?.routePath === '/404' || page?.routePath === '/offline'
	const visiblePages = pages
		.filter(
			(page) =>
				page.routePath !== '/' &&
				(!(isSpecialPage(page)) || page.hidden === false)
		)
		.sort((a, b) => a.routePath.localeCompare(b.routePath))

	const lines = [
		`# ${siteName || 'Methanol Site'}`,
		'',
		'No `index.md` or `index.mdx` found in your pages directory.',
		'',
		'## Pages'
	]

	if (!visiblePages.length) {
		lines.push('', 'No pages found yet.')
		return lines.join('\n')
	}

	lines.push('')
	for (const page of visiblePages) {
		const label = page.title || page.routePath
		lines.push(`- [${label}](${encodeURI(page.routePath)})`)
	}

	return lines.join('\n')
}

const resolveRootPath = (routePath, pagesByRoute) => {
	const normalized = normalizeRoutePath(routePath || '/')
	const segments = normalized.split('/').filter(Boolean)
	for (let i = segments.length; i >= 1; i--) {
		const candidate = `/${segments.slice(0, i).join('/')}`
		const page = pagesByRoute.get(candidate)
		if (page?.isIndex && page?.isRoot) {
			return page.routePath
		}
		const isExact = normalized === candidate
		if (!isExact) {
			const indexCandidate = candidate === '/' ? '/' : `${candidate}/`
			const indexPage = pagesByRoute.get(indexCandidate)
			if (indexPage?.isIndex && indexPage?.isRoot) {
				return indexPage.routePath
			}
		}
	}
	return '/'
}

const buildNavSequence = (nodes, pagesByRoute) => {
	const result = []
	const seen = new Set()
	const addEntry = (entry) => {
		if (!entry.routePath) return
		const key = entry.path || entry.routePath
		if (seen.has(key)) return
		seen.add(key)
		result.push(entry)
	}
	const walk = (items = []) => {
		for (const node of items) {
			if (node.type === 'directory') {
				if (node.routePath) {
					const page = pagesByRoute.get(node.routePath) || node.page || null
					if (page) addEntry(page)
				}
				if (node.children?.length) {
					walk(node.children)
				}
				continue
			}
			if (node.type === 'page') {
				const page = pagesByRoute.get(node.routePath) || node
				addEntry(page)
			}
		}
	}
	walk(nodes)
	return result
}

export const createPagesContextFromPages = ({ pages, excludedRoutes, excludedDirs } = {}) => {
	const pageList = Array.isArray(pages) ? pages : []
	const pagesAll = pageList
	const pagesByRoute = new Map()
	for (const page of pageList) {
		if (!pagesByRoute.has(page.routePath)) {
			pagesByRoute.set(page.routePath, page)
		}
	}
	const resolveParentDirRoute = (routePath) => {
		const normalized = normalizeRoutePath(routePath || '/')
		if (normalized === '/') return null
		if (normalized.endsWith('/')) {
			const stripped = stripTrailingSlash(normalized)
			const index = stripped.lastIndexOf('/')
			if (index <= 0) return '/'
			return `${stripped.slice(0, index)}/`
		}
		const index = normalized.lastIndexOf('/')
		if (index <= 0) return '/'
		return `${normalized.slice(0, index)}/`
	}
	const resolveHiddenAncestor = (routePath) => {
		let cursor = resolveParentDirRoute(routePath)
		while (cursor && cursor !== '/') {
			const page = pagesByRoute.get(cursor)
			if (page?.isIndex && page?.hidden) {
				return cursor
			}
			cursor = resolveParentDirRoute(cursor)
		}
		return null
	}
	for (const page of pageList) {
		const nearestHidden = resolveHiddenAncestor(page.routePath)
		page.hiddenByParent = nearestHidden
		page.hiddenByParents = Boolean(nearestHidden)
	}
	const isSpecialPage = (page) => page?.routePath === '/404' || page?.routePath === '/offline'
	const listForNavigation = pageList.filter(
		(page) => !(isSpecialPage(page) && page.hidden !== false)
	)
	const routeExcludes = excludedRoutes || new Set()
	const dirExcludes = excludedDirs || new Set()
	const getPageByRoute = (routePath, options = {}) => {
		const { path } = options || {}
		if (path) {
			for (const page of pagesAll) {
				if (page.routePath === routePath && page.path === path) {
					return page
				}
			}
		}
		return pagesByRoute.get(routePath) || null
	}
	const filterPagesForRoot = (rootPath) => {
		const normalizedRoot = normalizeRoutePath(rootPath || '/')
		return listForNavigation.filter((page) => {
			const resolvedRoot = resolveRootPath(page.routePath, pagesByRoute)
			if (normalizedRoot === '/') {
				return resolvedRoot === '/' || page.routePath === resolvedRoot
			}
			return resolvedRoot === normalizedRoot
		})
	}
	const buildGlobalTree = () =>
		buildPagesTree(filterPagesForRoot('/'), {
			rootPath: '/',
			includeHiddenRoot: false,
			currentRoutePath: '/'
		})
	let pagesTreeGlobal = buildGlobalTree()
	const treeByRoot = new Map()
	const navSequenceByRoot = new Map()

	const getFilteredTreeForRoot = (rootPath) => {
		const normalizedRoot = normalizeRoutePath(rootPath || '/')
		if (treeByRoot.has(normalizedRoot)) return treeByRoot.get(normalizedRoot)
		if (normalizedRoot === '/') {
			treeByRoot.set(normalizedRoot, pagesTreeGlobal)
			return pagesTreeGlobal
		}
		const scoped = buildPagesTree(filterPagesForRoot(normalizedRoot), {
			rootPath: normalizedRoot,
			includeHiddenRoot: false,
			currentRoutePath: normalizedRoot
		})
		treeByRoot.set(normalizedRoot, scoped)
		return scoped
	}

	const getPagesTree = (routePath = '/') => {
		const rootPath = resolveRootPath(routePath, pagesByRoute)
		return getFilteredTreeForRoot(rootPath)
	}

	const getNavSequence = (routePath = '/') => {
		const rootPath = resolveRootPath(routePath, pagesByRoute)
		const normalizedRoot = normalizeRoutePath(rootPath || '/')
		if (navSequenceByRoot.has(normalizedRoot)) {
			return navSequenceByRoot.get(normalizedRoot)
		}
		const tree = getFilteredTreeForRoot(rootPath)
		const sequence = buildNavSequence(tree, pagesByRoute)
		navSequenceByRoot.set(normalizedRoot, sequence)
		return sequence
	}
	const notFound = pagesByRoute.get('/404') || null
	const languages = collectLanguagesFromPages(pageList)
	const userSite = state.USER_SITE || {}
	const siteBase = state.VITE_BASE ?? userSite.base ?? null
	const feedPathValue = state.RSS_OPTIONS?.path
	const isAtomFeed = Boolean(state.RSS_OPTIONS?.atom)
	const defaultFeedPath = isAtomFeed ? '/atom.xml' : '/rss.xml'
	const feedPath = typeof feedPathValue === 'string' && feedPathValue.trim()
		? (feedPathValue.trim().startsWith('/') ? feedPathValue.trim() : `/${feedPathValue.trim()}`)
		: defaultFeedPath
	const feed = state.RSS_ENABLED
		? {
				enabled: true,
				atom: isAtomFeed,
				path: feedPath,
				href: withBase(feedPath)
			}
		: { enabled: false }
	const pwa = state.PWA_ENABLED
		? {
				enabled: true,
				manifestPath: '/manifest.webmanifest',
				manifestHref: withBase('/manifest.webmanifest')
			}
		: { enabled: false }
	const site = {
		...userSite,
		base: siteBase,
		name: state.SITE_NAME,
		owner: state.SITE_OWNER,
		root: state.ROOT_DIR,
		pagesDir: state.PAGES_DIR,
		componentsDir: state.COMPONENTS_DIR,
		publicDir: state.STATIC_DIR,
		distDir: state.DIST_DIR,
		mode: state.CURRENT_MODE,
		pagefind: {
			enabled: state.PAGEFIND_ENABLED,
			options: state.PAGEFIND_OPTIONS || null,
			build: state.PAGEFIND_BUILD || null
		},
		feed,
		pwa,
		generatedAt: new Date().toISOString()
	}
	const excludedDirPaths = new Set(Array.from(dirExcludes).map((dir) => `/${dir}`))
	const pagesContext = {
		pages: listForNavigation,
		pagesAll,
		pagesByRoute,
		getPageByRoute,
		pagesTree: pagesTreeGlobal,
		getPagesTree,
		derivedTitleCache: pageDerivedCache,
		setDerivedTitle: (path, title, toc) => {
			if (!path) return
			pageDerivedCache.set(path, { title, toc })
		},
		clearDerivedTitle: (path) => {
			if (!path) return
			pageDerivedCache.delete(path)
		},
		refreshPagesTree: () => {
			pagesTreeGlobal = buildGlobalTree()
			treeByRoot.clear()
			navSequenceByRoot.clear()
			pagesContext.pagesTree = pagesTreeGlobal
		},
		getSiblings: (routePath, path = null) => {
			if (!routePath) return { prev: null, next: null }
			const sequence = getNavSequence(routePath)
			if (!sequence.length) return { prev: null, next: null }
			let index = -1
			if (path) {
				index = sequence.findIndex((entry) => entry.path === path)
			}
			if (index < 0) {
				index = sequence.findIndex((entry) => entry.routePath === routePath)
			}
			if (index < 0) return { prev: null, next: null }
			const normalizedRoutePath = normalizeRoutePath(routePath)
			const isUnderRoute = (routeValue, baseValue) => {
				if (!routeValue || !baseValue) return false
				const route = normalizeRoutePath(routeValue)
				const base = normalizeRoutePath(baseValue)
				if (stripTrailingSlash(route) === stripTrailingSlash(base)) return true
				const basePrefix = base.endsWith('/') ? base : `${base}/`
				return route.startsWith(basePrefix)
			}
			const isVisible = (entry) => {
				if (!entry) return false
				if (entry.isRoot) {
					if (!entry.hidden || routePath.startsWith(entry.routePath)) {
						return true
					}
					return false
				}
				if (entry.hidden) {
					return isUnderRoute(normalizedRoutePath, entry.routePath)
				}
				const entryHiddenRoot = entry.hiddenByParent
				if (entryHiddenRoot && !isUnderRoute(normalizedRoutePath, entryHiddenRoot)) {
					return false
				}
				return true
			}
			let prevIndex = index - 1
			while (prevIndex >= 0 && !isVisible(sequence[prevIndex])) {
				prevIndex -= 1
			}
			let nextIndex = index + 1
			while (nextIndex < sequence.length && !isVisible(sequence[nextIndex])) {
				nextIndex += 1
			}
			const toNavEntry = (entry) => {
				if (!entry) return null
				return {
					routePath: entry.routePath,
					routeHref: entry.routeHref,
					title: entry.title || entry.name || entry.routePath,
					path: entry.path || null
				}
			}
			return {
				prev: toNavEntry(sequence[prevIndex] || null),
				next: toNavEntry(sequence[nextIndex] || null)
			}
		},
		refreshLanguages: () => {
			pagesContext.languages = collectLanguagesFromPages(pagesAll)
			pagesContext.getLanguageForRoute = (routePath) =>
				resolveLanguageForRoute(pagesContext.languages, routePath)
		},
		excludedRoutes: routeExcludes,
		excludedDirs: dirExcludes,
		excludedDirPaths,
		notFound,
		languages,
		getLanguageForRoute: (routePath) => resolveLanguageForRoute(languages, routePath),
		site
	}
	return pagesContext
}

export const buildPagesContext = async ({ compileAll = true } = {}) => {
	const logEnabled = state.CURRENT_MODE === 'production' && cli.command === 'build'
	const stageLogger = createStageLogger(logEnabled)
	const collectToken = stageLogger.start('Collecting pages')
	const collected = await collectPages()
	stageLogger.end(collectToken)
	let pages = collected.pages
	const excludedRoutes = collected.excludedRoutes
	const excludedDirs = collected.excludedDirs
	const hasIndex = pages.some((page) => page.routePath === '/')
	if (!hasIndex) {
		const content = buildIndexFallback(pages, state.SITE_NAME)
		pages.unshift({
			routePath: '/',
			routeHref: withBase('/'),
			path: resolve(state.PAGES_DIR, 'index.md'),
			relativePath: 'index.md',
			name: 'index',
			dir: '',
			segments: [],
			depth: 0,
			isIndex: true,
			title: state.SITE_NAME || 'Methanol Site',
			weight: null,
			date: null,
			isRoot: false,
			hidden: false,
			content,
			frontmatter: {},
			matter: null,
			stats: { size: content.length, createdAt: null, updatedAt: null },
			createdAt: null,
			updatedAt: null
		})
		if (excludedRoutes?.has('/')) {
			excludedRoutes.delete('/')
		}
	}

	const pagesContext = createPagesContextFromPages({
		pages,
		excludedRoutes,
		excludedDirs
	})
	if (compileAll) {
		const compileToken = stageLogger.start('Compiling MDX')
		const compileTargets = pages.filter((page) => page && page.content != null && !page.mdxComponent)
		const totalPages = compileTargets.length
		let completed = 0
		const compiledSources = await compileMdxSources(compileTargets, {
			onProgress: (page) => {
				if (!logEnabled) return
				completed += 1
				stageLogger.update(
					compileToken,
					`Compiling MDX [${completed}/${totalPages}] ${page.routePath || page.path}`
				)
			}
		})
		stageLogger.end(compileToken)
		const executeToken = stageLogger.start('Running MDX')
		completed = 0
		for (const page of compileTargets) {
			const compiled = compiledSources.get(page) || null
			await compilePageMdx(page, pagesContext, {
				lazyPagesTree: true,
				refreshPagesTree: false,
				compiled
			})
			if (logEnabled) {
				completed += 1
				stageLogger.update(
					executeToken,
					`Running MDX [${completed}/${totalPages}] ${page.routePath || page.path}`
				)
			}
		}
		stageLogger.end(executeToken)
		pagesContext.refreshPagesTree?.()
	}
	return pagesContext
}
