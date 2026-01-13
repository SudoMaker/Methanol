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

import '../register-loader.js'
import { parentPort, workerData } from 'worker_threads'
import { style } from '../logger.js'

const { mode = 'production', configPath = null, command = 'build', cli: cliOverrides = null } =
	workerData || {}
let initPromise = null
let pages = []
let pagesContext = null
let components = null

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
					client: themeEnv.client
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
	await rebuildPagesContext(new Set(excludedRoutes), new Set(excludedDirs))
}

const handleSyncUpdates = async (message) => {
	const { updates = [], titles = null, excludedRoutes = null, excludedDirs = null } = message || {}
	if (Array.isArray(titles)) {
		for (let i = 0; i < titles.length; i += 1) {
			const page = pages[i]
			if (!page) continue
			if (titles[i] !== undefined) {
				page.title = titles[i]
			}
		}
	}
	for (const update of updates) {
		const page = pages[update.id]
		if (!page) continue
		if (update.title !== undefined) page.title = update.title
		if (update.toc !== undefined) page.toc = update.toc
	}
	await rebuildPagesContext(
		excludedRoutes ? new Set(excludedRoutes) : pagesContext?.excludedRoutes || new Set(),
		excludedDirs ? new Set(excludedDirs) : pagesContext?.excludedDirs || new Set()
	)
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

const handleRender = async (message) => {
	const { ids = [], stage } = message || {}
	const { renderHtml } = await import('../mdx.js')
	const results = []
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
			results.push({ id, html })
		} catch (error) {
			logPageError('MDX render', page, error)
			throw error
		}
		completed += 1
		parentPort?.postMessage({ type: 'progress', stage, completed })
	}
	return results
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
			const results = await handleRender(message)
			parentPort?.postMessage({ type: 'done', stage, results })
			return
		}
	} catch (error) {
		parentPort?.postMessage({ type: 'error', stage, error: serializeError(error) })
	}
})
