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

import { writeFile, mkdir, rm, readFile, readdir, stat } from 'fs/promises'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { cpus } from 'os'
import { Worker } from 'worker_threads'
import { build as viteBuild, mergeConfig, normalizePath } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { state, cli } from './state.js'
import { resolveUserViteConfig } from './config.js'
import { buildPagesContext } from './pages.js'
import { buildComponentRegistry } from './components.js'
import { methanolVirtualHtmlPlugin, methanolResolverPlugin } from './vite-plugins.js'
import { createStageLogger } from './stage-logger.js'
import { preparePublicAssets } from './public-assets.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BUILD_WORKER_URL = new URL('./workers/build-worker.js', import.meta.url)

const ensureDir = async (dir) => {
	await mkdir(dir, { recursive: true })
}

const isHtmlFile = (name) => name.endsWith('.html')
const collectHtmlFiles = async (dir, basePath = '') => {
	const entries = await readdir(dir)
	const files = []
	for (const entry of entries.sort()) {
		const fullPath = resolve(dir, entry)
		const stats = await stat(fullPath)
		if (stats.isDirectory()) {
			const nextBase = basePath ? join(basePath, entry) : entry
			files.push(...(await collectHtmlFiles(fullPath, nextBase)))
			continue
		}
		if (!isHtmlFile(entry)) {
			continue
		}
		const baseName = entry.replace(/\.html$/, '')
		if (baseName.startsWith('_')) {
			continue
		}
		const relativePath = join(basePath, entry).replace(/\\/g, '/')
		files.push({ fullPath, relativePath })
	}
	return files
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

const createBuildWorkers = (pageCount) => {
	const workerCount = Math.min(resolveWorkerCount(pageCount), pageCount || 1) || 1
	const workers = []
	for (let i = 0; i < workerCount; i += 1) {
		workers.push(
			new Worker(BUILD_WORKER_URL, {
				type: 'module',
				workerData: {
					mode: state.CURRENT_MODE,
					configPath: cli.CLI_CONFIG_PATH
				}
			})
		)
	}
	const assignments = Array.from({ length: workers.length }, () => [])
	for (let i = 0; i < pageCount; i += 1) {
		assignments[i % workers.length].push(i)
	}
	return { workers, assignments }
}

const runWorkerStage = async ({ workers, stage, messages, onProgress, collect }) => {
	return await new Promise((resolve, reject) => {
		let completed = 0
		let doneCount = 0
		const results = []
		const handleFailure = (error) => {
			for (const w of workers) {
				const handler = handlers.get(w)
				if (handler) {
					w.off('message', handler)
					w.off('error', errorHandlers.get(w))
					w.off('exit', exitHandlers.get(w))
				}
			}
			reject(error instanceof Error ? error : new Error(String(error)))
		}
		const handleMessage = (worker, message) => {
			if (!message || message.stage !== stage) return
			if (message.type === 'progress') {
				completed += 1
				if (onProgress) {
					onProgress(completed)
				}
				return
			}
			if (message.type === 'done') {
				if (collect) {
					const data = collect(message)
					if (Array.isArray(data) && data.length) {
						results.push(...data)
					}
				}
				doneCount += 1
				if (doneCount >= workers.length) {
					for (const w of workers) {
						const handler = handlers.get(w)
						if (handler) {
							w.off('message', handler)
							w.off('error', errorHandlers.get(w))
							w.off('exit', exitHandlers.get(w))
						}
					}
					resolve(results)
				}
				return
			}
			if (message.type === 'error') {
				handleFailure(new Error(message.error || 'Worker error'))
			}
		}
		const handlers = new Map()
		const errorHandlers = new Map()
		const exitHandlers = new Map()
		for (const worker of workers) {
			const handler = (message) => handleMessage(worker, message)
			handlers.set(worker, handler)
			worker.on('message', handler)
			const errorHandler = (error) => handleFailure(error)
			const exitHandler = (code) => {
				if (code !== 0) {
					handleFailure(new Error(`Build worker exited with code ${code}`))
				}
			}
			errorHandlers.set(worker, errorHandler)
			exitHandlers.set(worker, exitHandler)
			worker.on('error', errorHandler)
			worker.on('exit', exitHandler)
		}
		for (const entry of messages) {
			entry.worker.postMessage(entry.message)
		}
	})
}

export const buildHtmlEntries = async () => {
	await resolveUserViteConfig('build') // Prepare `base`
	if (state.INTERMEDIATE_DIR) {
		await rm(state.INTERMEDIATE_DIR, { recursive: true, force: true })
		await ensureDir(state.INTERMEDIATE_DIR)
	}

	const logEnabled = state.CURRENT_MODE === 'production' && cli.command === 'build' && !cli.CLI_VERBOSE
	const stageLogger = createStageLogger(logEnabled)
	const themeComponentsDir = state.THEME_COMPONENTS_DIR
	const themeEnv = state.THEME_ENV
	if (themeComponentsDir) {
		await buildComponentRegistry({
			componentsDir: themeComponentsDir,
			client: themeEnv.client
		})
	}
	await buildComponentRegistry()
	const pagesContext = await buildPagesContext({ compileAll: false })
	const entry = {}
	const htmlCache = new Map()
	const resolveOutputName = (page) => {
		if (page.routePath === '/') return 'index'
		if (page.isIndex && page.dir) {
			return normalizePath(join(page.dir, 'index'))
		}
		return page.routePath.slice(1)
	}

	const pages = pagesContext.pages || []
	const totalPages = pages.length
	const { workers, assignments } = createBuildWorkers(totalPages)
	const excludedRoutes = Array.from(pagesContext.excludedRoutes || [])
	const excludedDirs = Array.from(pagesContext.excludedDirs || [])
	const cleanupWorkers = async () => {
		await Promise.all(workers.map((worker) => worker.terminate().catch(() => null)))
	}
	try {
		await runWorkerStage({
			workers,
			stage: 'setPages',
			messages: workers.map((worker) => ({
				worker,
				message: {
					type: 'setPages',
					stage: 'setPages',
					pages,
					excludedRoutes,
					excludedDirs
				}
			}))
		})

		const compileToken = stageLogger.start('Compiling MDX')
		let completed = 0
		const updates = await runWorkerStage({
			workers,
			stage: 'compile',
			messages: workers.map((worker, index) => ({
				worker,
				message: {
					type: 'compile',
					stage: 'compile',
					ids: assignments[index]
				}
			})),
			onProgress: (count) => {
				if (!logEnabled) return
				completed = count
				stageLogger.update(compileToken, `Compiling MDX [${completed}/${totalPages}]`)
			},
			collect: (message) => message.updates || []
		})
		stageLogger.end(compileToken)

		for (const update of updates) {
			const page = pages[update.id]
			if (!page) continue
			if (update.title !== undefined) page.title = update.title
			if (update.toc !== undefined) page.toc = update.toc
			if (typeof pagesContext.setDerivedTitle === 'function') {
				const shouldUseTocTitle = page.frontmatter?.title == null
				pagesContext.setDerivedTitle(page.path, shouldUseTocTitle ? page.title : null, page.toc || null)
			}
		}
		pagesContext.refreshPagesTree?.()

		await runWorkerStage({
			workers,
			stage: 'sync',
			messages: workers.map((worker) => ({
				worker,
				message: {
					type: 'sync',
					stage: 'sync',
					updates
				}
			}))
		})

		const renderToken = stageLogger.start('Rendering pages')
		completed = 0
		const rendered = await runWorkerStage({
			workers,
			stage: 'render',
			messages: workers.map((worker, index) => ({
				worker,
				message: {
					type: 'render',
					stage: 'render',
					ids: assignments[index]
				}
			})),
			onProgress: (count) => {
				if (!logEnabled) return
				completed = count
				stageLogger.update(renderToken, `Rendering pages [${completed}/${totalPages}]`)
			},
			collect: (message) => message.results || []
		})
		stageLogger.end(renderToken)

		for (const item of rendered) {
			const page = pages[item.id]
			if (!page) continue
			const html = item.html
			const name = resolveOutputName(page)
			const id = normalizePath(resolve(state.VIRTUAL_HTML_OUTPUT_ROOT, `${name}.html`))
			entry[name] = id
			htmlCache.set(id, html)
			if (state.INTERMEDIATE_DIR) {
				const outPath = resolve(state.INTERMEDIATE_DIR, `${name}.html`)
				await ensureDir(dirname(outPath))
				await writeFile(outPath, html)
			}
		}
	} finally {
		await cleanupWorkers()
	}

	const htmlFiles = await collectHtmlFiles(state.PAGES_DIR)
	const htmlExcludedDirs = pagesContext.excludedDirs || new Set()
	const isHtmlExcluded = (relativePath) => {
		if (!htmlExcludedDirs.size) return false
		const dir = relativePath.split('/').slice(0, -1).join('/')
		if (!dir) return false
		for (const excludedDir of htmlExcludedDirs) {
			if (!excludedDir) return true
			if (dir === excludedDir || dir.startsWith(`${excludedDir}/`)) {
				return true
			}
		}
		return false
	}
	for (const file of htmlFiles) {
		if (isHtmlExcluded(file.relativePath)) {
			continue
		}
		const name = file.relativePath.replace(/\.html$/, '')
		const outputName = name === 'index' ? 'index' : name
		if (entry[outputName]) {
			continue
		}
		const html = await readFile(file.fullPath, 'utf-8')
		const id = normalizePath(resolve(state.VIRTUAL_HTML_OUTPUT_ROOT, `${outputName}.html`))
		entry[outputName] = id
		htmlCache.set(id, html)
		if (state.INTERMEDIATE_DIR) {
			const outPath = resolve(state.INTERMEDIATE_DIR, file.relativePath)
			await ensureDir(dirname(outPath))
			await writeFile(outPath, html)
		}
	}

	return { entry, htmlCache, pagesContext }
}

export const runViteBuild = async (entry, htmlCache) => {
	const logEnabled = state.CURRENT_MODE === 'production' && cli.command === 'build' && !cli.CLI_VERBOSE
	const stageLogger = createStageLogger(logEnabled)
	const token = stageLogger.start('Building bundle')

	if (state.STATIC_DIR !== false && state.MERGED_ASSETS_DIR) {
		await preparePublicAssets({
			themeDir: state.THEME_ASSETS_DIR,
			userDir: state.USER_ASSETS_DIR,
			targetDir: state.MERGED_ASSETS_DIR
		})
	}
	const copyPublicDirEnabled = state.STATIC_DIR !== false
	const manifestConfig = state.PWA_OPTIONS?.manifest || {}
	const resolvedManifest = { name: state.SITE_NAME, short_name: state.SITE_NAME, ...manifestConfig }
	const baseConfig = {
		configFile: false,
		root: state.PAGES_DIR,
		appType: 'mpa',
		publicDir: state.STATIC_DIR === false ? false : state.STATIC_DIR,
		logLevel: cli.CLI_VERBOSE ? 'info' : 'silent',
		build: {
			outDir: state.DIST_DIR,
			emptyOutDir: true,
			rollupOptions: {
				input: entry
			},
			copyPublicDir: copyPublicDirEnabled,
			minify: true
		},
		esbuild: {
			jsx: 'automatic',
			jsxImportSource: 'refui'
		},
		resolve: {
			dedupe: ['refui', 'methanol']
		},
		plugins: [
			methanolVirtualHtmlPlugin(htmlCache),
			methanolResolverPlugin(),
			state.PWA_ENABLED
				? VitePWA({
						injectRegister: 'auto',
						registerType: 'autoUpdate',
						strategies: 'injectManifest',
						srcDir: resolve(__dirname, 'client'),
						filename: 'sw.js',
						manifest: resolvedManifest,
						injectManifest: {
							globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
							...(state.PWA_OPTIONS?.injectManifest || {})
						}
					})
				: null
		]
	}
	const userConfig = await resolveUserViteConfig('build')
	const finalConfig = userConfig ? mergeConfig(baseConfig, userConfig) : baseConfig

	const originalLog = console.log
	const originalWarn = console.warn
	if (!cli.CLI_VERBOSE) {
		console.log = () => {}
		console.warn = () => {}
	}

	try {
		await viteBuild(finalConfig)
	} finally {
		if (!cli.CLI_VERBOSE) {
			console.log = originalLog
			console.warn = originalWarn
		}
	}
	stageLogger.end(token)
}
