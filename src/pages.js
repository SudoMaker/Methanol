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
import { state, cli } from './state.js'
import { compilePageMdx } from './mdx.js'
import { createStageLogger } from './stage-logger.js'

const isPageFile = (name) => name.endsWith('.mdx') || name.endsWith('.md')
const isInternalPage = (name) => name.startsWith('_') || name.startsWith('.')
const isIgnoredEntry = (name) => name.startsWith('.') || name.startsWith('_')

const pageMetadataCache = new Map()
const pageDerivedCache = new Map()

const collectLanguagesFromPages = (pages = []) => {
	const languages = new Map()
	for (const page of pages) {
		if (!page?.isIndex) continue
		const label = page?.frontmatter?.lang
		if (label == null || label === '') continue
		const routePath = page.routePath || '/'
		const href = page.routeHref || routePath || '/'
		const frontmatterCode = page?.frontmatter?.langCode
		const code =
			typeof frontmatterCode === 'string' && frontmatterCode.trim()
				? frontmatterCode.trim()
				: routePath === '/'
					? null
					: routePath.replace(/^\/+/, '')
		languages.set(routePath, {
			routePath,
			href,
			label: String(label),
			code: code || null
		})
	}
	return Array.from(languages.values()).sort((a, b) => a.href.localeCompare(b.href))
}

const normalizeRoutePath = (value) => {
	if (!value || value === '/') return '/'
	return value.replace(/\/+$/, '')
}

const resolveLanguageForRoute = (languages = [], routePath = '/') => {
	if (!languages.length) return null
	const normalizedRoute = normalizeRoutePath(routePath)
	let best = null
	let bestLength = -1
	let rootLanguage = null
	for (const lang of languages) {
		const base = normalizeRoutePath(lang?.routePath || lang?.href)
		if (!base) continue
		if (base === '/') {
			rootLanguage = lang
			continue
		}
		if (normalizedRoute === base || normalizedRoute.startsWith(`${base}/`)) {
			if (base.length > bestLength) {
				best = lang
				bestLength = base.length
			}
		}
	}
	return best || rootLanguage
}

export const routePathFromFile = (filePath, pagesDir = state.PAGES_DIR) => {
	if (!filePath.endsWith('.mdx') && !filePath.endsWith('.md')) {
		return null
	}
	const relPath = relative(pagesDir, filePath)
	if (relPath.startsWith('..')) {
		return null
	}
	const name = relPath.replace(/\.(mdx|md)$/, '')
	const baseName = name.split(/[\\/]/).pop()
	if (isInternalPage(baseName)) {
		return null
	}
	const normalized = name.replace(/\\/g, '/')
	if (normalized === 'index') {
		return '/'
	}
	if (normalized.endsWith('/index')) {
		return `/${normalized.slice(0, -'/index'.length)}`
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

const parsePageMetadata = async (filePath) => {
	const raw = await readFile(filePath, 'utf-8')
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
	const rootDir = rootPath === '/' ? '' : rootPath.replace(/^\/+/, '')
	const includeHiddenRoot = Boolean(options.includeHiddenRoot)
	const currentRoutePath = normalizeRoutePath(options.currentRoutePath || '/')
	const rootSegments = rootDir ? rootDir.split('/') : []
	const resolveRouteWithinRoot = (routePath) => {
		if (!routePath) return '/'
		if (!rootDir) return routePath
		if (routePath === rootPath) return '/'
		if (routePath.startsWith(`${rootPath}/`)) {
			const stripped = routePath.slice(rootPath.length)
			return stripped.startsWith('/') ? stripped : `/${stripped}`
		}
		return routePath
	}
	const currentRouteWithinRoot = resolveRouteWithinRoot(currentRoutePath)
	const isUnderRoot = (page) => {
		if (!rootDir) return true
		return page.routePath === rootPath || page.routePath.startsWith(`${rootPath}/`)
	}
	const treePages = pages
		.filter((page) => !page.isInternal)
		.filter((page) => isUnderRoot(page))
		.map((page) => {
			if (!rootDir) return page
			const relativePath = stripRootPrefix(page.relativePath, rootDir)
			const dir = stripRootPrefix(page.dir, rootDir)
			const segments = page.segments.slice(rootSegments.length)
			const depth = segments.length
			return {
				...page,
				relativePath,
				dir,
				segments,
				depth
			}
		})
	const root = []
	const dirs = new Map()
	const hiddenDirs = new Set(
		treePages
			.filter((page) => page.isIndex && page.dir && page.hidden && !(includeHiddenRoot && page.routePath === rootPath))
			.map((page) => page.dir)
	)
	const exposedHiddenDirs = new Set()
	if (currentRoutePath && currentRoutePath !== '/' && hiddenDirs.size) {
		for (const hiddenDir of hiddenDirs) {
			const hiddenRoute = `/${hiddenDir}`
			if (
				currentRouteWithinRoot === hiddenRoute ||
				currentRouteWithinRoot.startsWith(`${hiddenRoute}/`)
			) {
				exposedHiddenDirs.add(hiddenDir)
			}
		}
	}
	if (includeHiddenRoot && rootDir) {
		for (const hiddenDir of Array.from(hiddenDirs)) {
			if (rootDir === hiddenDir || rootDir.startsWith(`${hiddenDir}/`)) {
				hiddenDirs.delete(hiddenDir)
			}
		}
	}
	if (exposedHiddenDirs.size) {
		for (const hiddenDir of exposedHiddenDirs) {
			hiddenDirs.delete(hiddenDir)
		}
	}
	const isUnderHiddenDir = (dir) => {
		if (!dir) return false
		const parts = dir.split('/')
		for (let i = 1; i <= parts.length; i++) {
			const candidate = parts.slice(0, i).join('/')
			if (hiddenDirs.has(candidate)) {
				return true
			}
		}
		return false
	}
	const getDirNode = (path, name, depth) => {
		if (dirs.has(path)) return dirs.get(path)
		const dir = {
			type: 'directory',
			name,
			path: `/${path}`,
			children: [],
			depth,
			routePath: null,
			title: null,
			weight: null,
			date: null,
			routeHref: null,
			isRoot: false
		}
		dirs.set(path, dir)
		return dir
	}
	const isUnderExposedHiddenDir = (dir) => {
		if (!dir || !exposedHiddenDirs.size) return false
		for (const hiddenDir of exposedHiddenDirs) {
			if (dir === hiddenDir || dir.startsWith(`${hiddenDir}/`)) {
				return true
			}
		}
		return false
	}
	for (const page of treePages) {
		if (page.hidden && !(includeHiddenRoot && page.routePath === rootPath)) {
			const isHidden404 = page.routePath === '/404'
			const shouldExposeHidden =
				!isHidden404 &&
				page.hiddenByFrontmatter === true &&
				(
					page.routePath === currentRoutePath ||
					(page.isIndex && page.dir && isUnderExposedHiddenDir(page.dir))
				)
			if (!shouldExposeHidden) {
				continue
			}
		}
		if (isUnderHiddenDir(page.dir)) {
			continue
		}
		const parts = page.relativePath.split('/')
		parts.pop()
		let cursor = root
		let currentPath = ''
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part
			if (hiddenDirs.has(currentPath)) {
				cursor = null
				break
			}
			const dir = getDirNode(currentPath, part, currentPath.split('/').length)
			if (!cursor.includes(dir)) {
				cursor.push(dir)
			}
			cursor = dir.children
		}
		if (!cursor) {
			continue
		}
		if (page.isIndex && page.dir) {
			const dir = getDirNode(page.dir, page.dir.split('/').pop(), page.depth)
			dir.routePath = page.routePath
			dir.routeHref = page.routeHref || page.routePath
			dir.title = page.title
			dir.weight = page.weight ?? null
			dir.date = page.date ?? null
			dir.isRoot = page.isRoot || false
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
		const routePath = isIndex ? (basePath ? `/${basePath}` : '/') : `/${relativePath}`
		const routeHref = isIndex && basePath ? `/${basePath}/` : routePath
		yield { routePath, routeHref, filePath: fullPath, isIndex }
	}

	for (const { entry, fullPath } of dirs) {
		yield* walkPages(fullPath, join(basePath, entry))
	}
}

export const buildPageEntry = async ({ filePath, pagesDir, source }) => {
	const routePath = routePathFromFile(filePath, pagesDir)
	if (!routePath) return null
	const relPath = relative(pagesDir, filePath).replace(/\\/g, '/')
	const name = relPath.replace(/\.(mdx|md)$/, '')
	const baseName = name.split('/').pop()
	const dir = name.split('/').slice(0, -1).join('/')
	const dirName = dir ? dir.split('/').pop() : ''
	const isIndex = baseName === 'index'
	const routeHref = isIndex && dir ? `/${dir}/` : routePath
	const segments = routePath.split('/').filter(Boolean)
	const stats = await stat(filePath)
	const cached = pageMetadataCache.get(filePath)
	let metadata = null
	if (cached && cached.mtimeMs === stats.mtimeMs) {
		metadata = cached.metadata
	} else {
		metadata = await parsePageMetadata(filePath)
		pageMetadataCache.set(filePath, { mtimeMs: stats.mtimeMs, metadata })
	}
	const derived = pageDerivedCache.get(filePath)
	const exclude = Boolean(metadata.frontmatter?.exclude)
	const frontmatterHidden = metadata.frontmatter?.hidden
	const hiddenByFrontmatter = frontmatterHidden === true
	const isNotFoundPage = routePath === '/404'
	const hidden = frontmatterHidden === false
		? false
		: frontmatterHidden === true
			? true
			: isNotFoundPage || Boolean(metadata.frontmatter?.isRoot)
	return {
		routePath,
		routeHref,
		filePath,
		source,
		relativePath: relPath,
		name: baseName,
		dir,
		segments,
		depth: segments.length,
		isIndex,
		isInternal: isInternalPage(baseName),
		title: metadata.title || derived?.title || (baseName === 'index' ? (dirName || 'Home') : baseName),
		weight: parseWeight(metadata.frontmatter?.weight),
		date: parseDate(metadata.frontmatter?.date) || parseDate(stats.mtime),
		isRoot: Boolean(metadata.frontmatter?.isRoot),
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
		},
		createdAt: stats.birthtime?.toISOString?.() || null,
		updatedAt: stats.mtime?.toISOString?.() || null
	}
}

const collectPagesFromDir = async (pagesDir, source) => {
	if (!pagesDir || !existsSync(pagesDir)) {
		return []
	}
	const pages = []
	for await (const page of walkPages(pagesDir)) {
		const entry = await buildPageEntry({
			filePath: page.filePath,
			pagesDir,
			source
		})
		if (entry) {
			entry.routeHref = page.routeHref || entry.routeHref
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
	const visiblePages = pages
		.filter((page) => !page.isInternal && page.routePath !== '/')
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

const resolveRootPath = (routePath, pagesByRoute, pagesByRouteIndex = null) => {
	const normalized = normalizeRoutePath(routePath || '/')
	const segments = normalized.split('/').filter(Boolean)
	const lookup = pagesByRouteIndex || pagesByRoute
	for (let i = segments.length; i >= 1; i--) {
		const candidate = `/${segments.slice(0, i).join('/')}`
		const page = lookup.get(candidate)
		if (page?.isIndex && page?.isRoot) {
			return candidate
		}
	}
	return '/'
}

const buildNavSequence = (nodes, pagesByRoute) => {
	const result = []
	const seen = new Set()
	const addEntry = (entry) => {
		if (!entry?.routePath) return
		const key = entry.filePath || entry.routePath
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
		pages = [
			{
				routePath: '/',
				routeHref: '/',
				filePath: resolve(state.PAGES_DIR, 'index.md'),
				relativePath: 'index.md',
				name: 'index',
				dir: '',
				segments: [],
				depth: 0,
				isIndex: true,
				isInternal: false,
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
			},
			...pages
		]
		if (excludedRoutes?.has('/')) {
			excludedRoutes.delete('/')
		}
	}

	const pagesByRoute = new Map()
	const pagesByRouteIndex = new Map()
	for (const page of pages) {
		if (page.isIndex) {
			pagesByRouteIndex.set(page.routePath, page)
			if (!pagesByRoute.has(page.routePath)) {
				pagesByRoute.set(page.routePath, page)
			}
			continue
		}
		const existing = pagesByRoute.get(page.routePath)
		if (!existing || existing.isIndex) {
			pagesByRoute.set(page.routePath, page)
		}
	}
	const getPageByRoute = (routePath, options = {}) => {
		const { filePath, preferIndex } = options || {}
		if (filePath) {
			for (const page of pages) {
				if (page.routePath === routePath && page.filePath === filePath) {
					return page
				}
			}
		}
		if (preferIndex === true) {
			return pagesByRouteIndex.get(routePath) || pagesByRoute.get(routePath) || null
		}
		if (preferIndex === false) {
			return pagesByRoute.get(routePath) || pagesByRouteIndex.get(routePath) || null
		}
		return pagesByRoute.get(routePath) || pagesByRouteIndex.get(routePath) || null
	}
	const pagesTreeCache = new Map()
	const navSequenceCache = new Map()
	const getPagesTree = (routePath) => {
		const rootPath = resolveRootPath(routePath, pagesByRoute, pagesByRouteIndex)
		const normalizedRoute = normalizeRoutePath(routePath || '/')
		const cacheKey = `${rootPath}::${normalizedRoute}`
		if (pagesTreeCache.has(cacheKey)) {
			return pagesTreeCache.get(cacheKey)
		}
		const tree = buildPagesTree(pages, {
			rootPath,
			includeHiddenRoot: rootPath !== '/',
			currentRoutePath: normalizedRoute
		})
		pagesTreeCache.set(cacheKey, tree)
		return tree
	}
	const getNavSequence = (routePath) => {
		const rootPath = resolveRootPath(routePath, pagesByRoute, pagesByRouteIndex)
		const normalizedRoute = normalizeRoutePath(routePath || '/')
		const cacheKey = `${rootPath}::${normalizedRoute}`
		if (navSequenceCache.has(cacheKey)) {
			return navSequenceCache.get(cacheKey)
		}
		const tree = getPagesTree(routePath)
		const sequence = buildNavSequence(tree, pagesByRoute)
		navSequenceCache.set(cacheKey, sequence)
		return sequence
	}
	let pagesTree = getPagesTree('/')
	const notFound = pagesByRoute.get('/404') || null
	const languages = collectLanguagesFromPages(pages)
	const userSite = state.USER_SITE || {}
	const site = {
		...userSite,
		name: state.SITE_NAME,
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
		generatedAt: new Date().toISOString()
	}
	const excludedDirPaths = new Set(Array.from(excludedDirs).map((dir) => `/${dir}`))
	const pagesContext = {
		pages,
		pagesByRoute,
		pagesByRouteIndex,
		getPageByRoute,
		pagesTree,
		getPagesTree,
		derivedTitleCache: pageDerivedCache,
		setDerivedTitle: (filePath, title, toc) => {
			if (!filePath) return
			pageDerivedCache.set(filePath, { title, toc })
		},
		clearDerivedTitle: (filePath) => {
			if (!filePath) return
			pageDerivedCache.delete(filePath)
		},
		refreshPagesTree: () => {
			pagesTreeCache.clear()
			navSequenceCache.clear()
			pagesContext.pagesTree = getPagesTree('/')
		},
		getSiblings: (routePath, filePath = null) => {
			if (!routePath) return { prev: null, next: null }
			const sequence = getNavSequence(routePath)
			if (!sequence.length) return { prev: null, next: null }
			let index = -1
			if (filePath) {
				index = sequence.findIndex((entry) => entry.filePath === filePath)
			}
			if (index < 0) {
				index = sequence.findIndex((entry) => entry.routePath === routePath)
			}
			if (index < 0) return { prev: null, next: null }
			const toNavEntry = (entry) => {
				if (!entry) return null
				return {
					routePath: entry.routePath,
					routeHref: entry.routeHref || entry.routePath,
					title: entry.title || entry.name || entry.routePath,
					filePath: entry.filePath || null
				}
			}
			return {
				prev: toNavEntry(sequence[index - 1] || null),
				next: toNavEntry(sequence[index + 1] || null)
			}
		},
		refreshLanguages: () => {
			pagesContext.languages = collectLanguagesFromPages(pages)
			pagesContext.getLanguageForRoute = (routePath) =>
				resolveLanguageForRoute(pagesContext.languages, routePath)
		},
		excludedRoutes,
		excludedDirs,
		excludedDirPaths,
		notFound,
		languages,
		getLanguageForRoute: (routePath) => resolveLanguageForRoute(languages, routePath),
		site
	}
	if (compileAll) {
		const compileToken = stageLogger.start('Compiling MDX')
		const totalPages = pages.length
		for (let i = 0; i < pages.length; i++) {
			const page = pages[i]
			if (logEnabled) {
				stageLogger.update(compileToken, `Compiling MDX [${i + 1}/${totalPages}] ${page.filePath}`)
			}
			await compilePageMdx(page, pagesContext, {
				lazyPagesTree: true,
				refreshPagesTree: false
			})
		}
		stageLogger.end(compileToken)
		pagesTreeCache.clear()
		pagesTree = getPagesTree('/')
		pagesContext.pagesTree = pagesTree
	}
	return pagesContext
}
