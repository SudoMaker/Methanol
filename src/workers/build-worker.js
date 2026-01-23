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

import { parentPort, workerData } from 'worker_threads'
import { mkdir, writeFile, readFile, copyFile } from 'fs/promises'
import { resolve, join, dirname } from 'path'
import { style } from '../logger.js'
import { scanRenderedHtml, rewriteHtmlContent, resolveManifestEntry } from '../html/worker-html.js'

const { mode = 'production', configPath = null, command = 'build', cli: cliOverrides = null } =
	workerData || {}
let initPromise = null
let pages = []
let pagesContext = null
let components = null
let mdxPageIds = new Set()
const parsedHtmlCache = new Map()

const ensureInit = async () => {
	if (initPromise) return initPromise
	initPromise = (async () => {
		const { loadUserConfig, applyConfig, resolveUserViteConfig } = await import('../config.js')
		const { buildComponentRegistry } = await import('../components.js')
		const { state, cli } = await import('../state.js')
		if (cliOverrides) {
			Object.assign(cli, cliOverrides)
		}
		const config = await loadUserConfig(mode, configPath)
		await applyConfig(config, mode)
		await resolveUserViteConfig(command)
		const themeComponentsDir = state.THEME_COMPONENTS_DIR
		const themeEnv = state.THEME_ENV
		const themeRegistry = themeComponentsDir
			? await buildComponentRegistry({
					componentsDir: themeComponentsDir,
					register: themeEnv.register
				})
			: { components: {} }
		const themeComponents = {
			...(themeRegistry.components || {}),
			...(state.USER_THEME.components || {})
		}
		const registry = await buildComponentRegistry()
		components = {
			...themeComponents,
			...(registry.components || {})
		}
	})()
	return initPromise
}

const rebuildPagesContext = async (excludedRoutes, excludedDirs) => {
	const { createPagesContextFromPages } = await import('../pages.js')
	pagesContext = createPagesContextFromPages({
		pages,
		excludedRoutes,
		excludedDirs
	})
}

const refreshMdxCtx = (page) => {
	if (!page?.mdxCtx || !pagesContext) return
	const ctx = page.mdxCtx
	ctx.page = page
	ctx.pages = pagesContext.pages || []
	ctx.pagesByRoute = pagesContext.pagesByRoute || new Map()
	ctx.languages = pagesContext.languages || []
	ctx.language = pagesContext.getLanguageForRoute
		? pagesContext.getLanguageForRoute(page.routePath)
		: null
	ctx.site = pagesContext.site || null
	ctx.getSiblings = pagesContext.getSiblings
		? () => pagesContext.getSiblings(page.routePath, page.path)
		: null
	if (page && ctx.getSiblings && page.getSiblings !== ctx.getSiblings) {
		page.getSiblings = ctx.getSiblings
	}
	if (pagesContext.getPagesTree) {
		ctx.pagesTree = pagesContext.getPagesTree(page.routePath)
	} else {
		ctx.pagesTree = pagesContext.pagesTree || []
	}
}

const serializeError = (error) => {
	if (!error) return 'Unknown error'
	if (error.stack) return error.stack
	if (error.message) return error.message
	return String(error)
}

const logPageError = (phase, page, error) => {
	const target = page?.path || page?.routePath || 'unknown file'
	console.error(style.red(`\n\n[methanol] ${phase} error in ${target}`))
	// Error is thrown so wo don't need to print here
	// console.error(error?.stack || error)
}

const handleSetPages = async (message) => {
	const { pages: nextPages, excludedRoutes = [], excludedDirs = [] } = message || {}
	pages = Array.isArray(nextPages) ? nextPages : []
	mdxPageIds = new Set()
	await rebuildPagesContext(new Set(excludedRoutes), new Set(excludedDirs))
}

const handleSetPagesLite = async (message) => {
	const { pages: nextPages } = message || {}
	pages = Array.isArray(nextPages) ? nextPages : []
}

const handleSyncUpdates = async (message) => {
	const { updates = [], excludedRoutes = null, excludedDirs = null } = message || {}
	for (const update of updates) {
		const page = pages[update.id]
		if (!page) continue
		if (update.title !== undefined) page.title = update.title
	}
	if (!pagesContext || excludedRoutes || excludedDirs) {
		await rebuildPagesContext(
			excludedRoutes ? new Set(excludedRoutes) : pagesContext?.excludedRoutes || new Set(),
			excludedDirs ? new Set(excludedDirs) : pagesContext?.excludedDirs || new Set()
		)
	} else {
		pagesContext.refreshPagesTree?.(true)
	}
	for (const id of mdxPageIds) {
		const page = pages[id]
		if (!page?.mdxCtx) continue
		refreshMdxCtx(page)
	}
}

const handleCompile = async (message) => {
	const { ids = [], stage } = message || {}
	const { compilePageMdx } = await import('../mdx.js')
	const updates = []
	let completed = 0
	for (const id of ids) {
		const page = pages[id]
		if (!page || page.content == null || page.mdxComponent) {
			completed += 1
			parentPort?.postMessage({ type: 'progress', stage, completed })
			continue
		}
		try {
			await compilePageMdx(page, pagesContext, {
				lazyPagesTree: true,
				refreshPagesTree: false
			})
			mdxPageIds.add(id)
			updates.push({ id, title: page.title, toc: page.toc || null })
		} catch (error) {
			logPageError('MDX compile', page, error)
			throw error
		}
		completed += 1
		parentPort?.postMessage({ type: 'progress', stage, completed })
	}
	return updates
}

const MAX_PENDING_WRITES = 32

const handleRender = async (message) => {
	const { ids = [], stage, feedIds = [], htmlStageDir = null, writeConcurrency = null } = message || {}
	const { renderHtml, renderPageContent } = await import('../mdx.js')
	const feedSet = new Set(Array.isArray(feedIds) ? feedIds : [])
	const writeLimit =
		typeof writeConcurrency === 'number' && Number.isFinite(writeConcurrency)
			? Math.max(1, Math.floor(writeConcurrency))
			: MAX_PENDING_WRITES
	const pendingWrites = []
	let completed = 0
	for (const id of ids) {
		const page = pages[id]
		if (!page) {
			completed += 1
			parentPort?.postMessage({ type: 'progress', stage, completed })
			continue
		}
		try {
			const html = await renderHtml({
				routePath: page.routePath,
				path: page.path,
				components,
				pagesContext,
				pageMeta: page
			})
			let outputHtml = html
			let scan = null
			let feedContent = null
			if (feedSet.has(id)) {
				feedContent = await renderPageContent({
					routePath: page.routePath,
					path: page.path,
					components,
					pagesContext,
					pageMeta: page
				})
			}
			let stagePath = null
			if (htmlStageDir) {
				const scanned = await scanRenderedHtml(outputHtml, page.routePath)
				outputHtml = scanned.html
				scan = scanned.scan
				const hasResources =
					scan.scripts.length > 0 || scan.styles.length > 0 || scan.assets.length > 0
				if (hasResources) {
					parsedHtmlCache.set(id, scanned.plan)
				}
				const name = resolveOutputName(page)
				stagePath = resolve(htmlStageDir, `${name}.html`)
				pendingWrites.push(
					(async () => {
						await mkdir(dirname(stagePath), { recursive: true })
						await writeFile(stagePath, outputHtml)
					})()
				)
				if (pendingWrites.length >= writeLimit) {
					const results = await Promise.allSettled(pendingWrites)
					pendingWrites.length = 0
					const failed = results.find((result) => result.status === 'rejected')
					if (failed) {
						throw failed.reason
					}
				}
			}
			page.mdxComponent = null
			parentPort?.postMessage({
				type: 'result',
				stage,
				result: {
					id,
					html: htmlStageDir ? null : outputHtml,
					stagePath,
					feedContent,
					scan
				}
			})
		} catch (error) {
			logPageError('MDX render', page, error)
			throw error
		}
		completed += 1
		parentPort?.postMessage({ type: 'progress', stage, completed })
	}
	if (pendingWrites.length) {
		const results = await Promise.allSettled(pendingWrites)
		const failed = results.find((result) => result.status === 'rejected')
		if (failed) {
			throw failed.reason
		}
	}
}

const resolveOutputName = (page) => {
	if (!page) return 'index'
	if (page.routePath === '/') return 'index'
	if (page.isIndex && page.dir) {
		return join(page.dir, 'index').replace(/\\/g, '/')
	}
	return page.routePath.slice(1)
}

const handleRewrite = async (message) => {
	const {
		ids = [],
		stage,
		htmlStageDir,
		manifest,
		entryModules = [],
		commonScripts = [],
		commonEntry = null,
		scans = {}
	} = message || {}
	const { state } = await import('../state.js')
	const { resolveBasePrefix } = await import('../config.js')
	const basePrefix = resolveBasePrefix()
	const scriptMap = new Map()
	const styleMap = new Map()
	for (const entry of entryModules) {
		if (!entry?.publicPath || !entry?.manifestKey) continue
		const manifestEntry = resolveManifestEntry(manifest, entry.manifestKey)
		if (!manifestEntry?.file) continue
		if (entry.kind === 'script') {
			scriptMap.set(entry.publicPath, { file: manifestEntry.file, css: manifestEntry.css || null })
		}
		if (entry.kind === 'style') {
			const cssFile = manifestEntry.css?.[0] || (manifestEntry.file.endsWith('.css') ? manifestEntry.file : null)
			if (cssFile) {
				styleMap.set(entry.publicPath, { file: cssFile, css: manifestEntry.css || null })
			}
		}
	}
	const commonSet = new Set(commonScripts || [])
	let completed = 0
	for (const id of ids) {
		const page = pages[id]
		if (!page) {
			completed += 1
			parentPort?.postMessage({ type: 'progress', stage, completed })
			continue
		}
		try {
			const name = resolveOutputName(page)
			const stagePath = htmlStageDir ? resolve(htmlStageDir, `${name}.html`) : null
			const distPath = resolve(state.DIST_DIR, `${name}.html`)
			await mkdir(dirname(distPath), { recursive: true })
			const scan = scans?.[id] || null
			if (scan && Array.isArray(scan.scripts) && Array.isArray(scan.styles) && Array.isArray(scan.assets)) {
				if (scan.scripts.length === 0 && scan.styles.length === 0 && scan.assets.length === 0) {
					await copyFile(stagePath, distPath)
					completed += 1
					parentPort?.postMessage({ type: 'progress', stage, completed })
					continue
				}
			}
			const plan = parsedHtmlCache.get(id)
			const html = await readFile(stagePath, 'utf-8')
			if (html == null) {
				throw new Error('HTML content not available for rewrite')
			}
			const output = rewriteHtmlContent(
				html,
				plan,
				page.routePath,
				basePrefix,
				manifest,
				scriptMap,
				styleMap,
				commonSet,
				commonEntry
			)
			parsedHtmlCache.delete(id)
			await writeFile(distPath, output)
			parentPort?.postMessage({ type: 'result', stage, result: { id } })
		} catch (error) {
			logPageError('HTML rewrite', page, error)
			throw error
		}
		completed += 1
		parentPort?.postMessage({ type: 'progress', stage, completed })
	}
}

parentPort?.on('message', async (message) => {
	const { type, stage } = message || {}
	try {
		await ensureInit()
		if (type === 'setPages') {
			await handleSetPages(message)
			parentPort?.postMessage({ type: 'done', stage: 'setPages' })
			return
		}
		if (type === 'setPagesLite') {
			await handleSetPagesLite(message)
			parentPort?.postMessage({ type: 'done', stage: 'setPagesLite' })
			return
		}
		if (type === 'sync') {
			await handleSyncUpdates(message)
			parentPort?.postMessage({ type: 'done', stage: 'sync' })
			return
		}
		if (type === 'compile') {
			const updates = await handleCompile(message)
			parentPort?.postMessage({ type: 'done', stage, updates })
			return
		}
		if (type === 'render') {
			await handleRender(message)
			parentPort?.postMessage({ type: 'done', stage })
			return
		}
		if (type === 'rewrite') {
			await handleRewrite(message)
			parentPort?.postMessage({ type: 'done', stage })
			return
		}
	} catch (error) {
		parentPort?.postMessage({ type: 'error', stage, error: serializeError(error) })
	}
})
