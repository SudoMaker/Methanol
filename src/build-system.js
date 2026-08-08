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

import { existsSync } from 'fs'
import { writeFile, mkdir, rm, readFile, readdir, stat, copyFile, cp } from 'fs/promises'
import { resolve, dirname, join } from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { createRsbuild, mergeRsbuildConfig } from '@rsbuild/core'
import { state, cli } from './state.js'
import { resolveUserRsbuildConfig } from './config.js'
import { buildPagesContext } from './pages.js'
import { selectFeedPages } from './feed.js'
import { buildComponentRegistry } from './components.js'
import { createBuildWorkers, runWorkerStage, terminateWorkers } from './workers/build-pool.js'
import { MethanolResolverPlugin, createMethanolVirtualModules } from './rsbuild-plugins.js'
import { createAssetManifest, entryAssetsFromStats } from './asset-manifest.js'
import { createStageLogger } from './stage-logger.js'
import { preparePublicAssets } from './public-assets.js'
import { normalizePath } from './path-utils.js'
import { rewriteHtmlEntries } from './html/build-html.js'
export { scanHtmlEntries, rewriteHtmlEntries } from './html/build-html.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const ensureDir = async (dir) => {
	await mkdir(dir, { recursive: true })
}

const INLINE_DIR = 'inline'
const WRITE_CONCURRENCY_LIMIT = 32

const resolveMethanolDir = () => resolve(state.PAGES_DIR, '.methanol')

const isHtmlFile = (name) => name.endsWith('.html')
const collectHtmlFiles = async (dir, basePath = '') => {
	const entries = await readdir(dir, { withFileTypes: true })
	const files = []
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const name = entry.name
		if (name.startsWith('.') || name.startsWith('_')) {
			continue
		}
		const fullPath = resolve(dir, name)
		const isDirectory = entry.isDirectory() || (
			entry.isSymbolicLink() && (await stat(fullPath)).isDirectory()
		)
		if (isDirectory) {
			const nextBase = basePath ? join(basePath, name) : name
			files.push(...(await collectHtmlFiles(fullPath, nextBase)))
			continue
		}
		if (!isHtmlFile(name)) {
			continue
		}
		const baseName = name.replace(/\.html$/, '')
		if (baseName.startsWith('_')) {
			continue
		}
		const relativePath = join(basePath, name).replace(/\\/g, '/')
		files.push({ fullPath, relativePath })
	}
	return files
}

const hashKey = (value) =>
	createHash('md5').update(value).digest('hex')

const makeInputKey = (prefix, value) => `${prefix}-${hashKey(value).slice(0, 12)}`

export const buildHtmlEntries = async (options = {}) => {
	const keepWorkers = Boolean(options.keepWorkers)
	await resolveUserRsbuildConfig('build') // Prepare the asset base.
	const htmlStageDir = state.INTERMEDIATE_DIR || resolve(state.PAGES_DIR, '.methanol/html')
	if (htmlStageDir) {
		await rm(htmlStageDir, { recursive: true, force: true })
		await ensureDir(htmlStageDir)
	}

	const logEnabled = state.CURRENT_MODE === 'production' && cli.command === 'build' && !cli.CLI_VERBOSE
	const stageLogger = createStageLogger(logEnabled)
	const themeComponentsDir = state.THEME_COMPONENTS_DIR
	const themeEnv = state.THEME_ENV
	if (themeComponentsDir) {
		await buildComponentRegistry({
			componentsDir: themeComponentsDir,
			register: themeEnv.register
		})
	}
	await buildComponentRegistry()
	const pagesContext = await buildPagesContext({ compileAll: false })
	const htmlEntries = []
	const htmlEntryNames = new Set()
	const inlineDir = resolve(resolveMethanolDir(), INLINE_DIR)
	await rm(inlineDir, { recursive: true, force: true })
	await ensureDir(inlineDir)
	const renderScans = new Map()
	const renderScansById = new Map()
	const resolveOutputName = (page) => {
		if (page.routePath === '/') return 'index'
		if (page.isIndex && page.dir) {
			return normalizePath(join(page.dir, 'index'))
		}
		return page.routePath.slice(1)
	}

	const pages = pagesContext.pagesAll || pagesContext.pages || []
	const totalPages = pages.length
	const { workers, assignments } = createBuildWorkers(totalPages)
	const writeConcurrency = Math.max(1, Math.floor(WRITE_CONCURRENCY_LIMIT / workers.length))
	const excludedRoutes = Array.from(pagesContext.excludedRoutes || [])
	const excludedDirs = Array.from(pagesContext.excludedDirs || [])
	const rssContent = new Map()
	let feedIds = []
	let feedAssignments = null
	let completedRun = false
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

		const titleUpdates = updates
			.filter((update) => update && update.title !== undefined)
			.map((update) => ({ id: update.id, title: update.title }))

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
		state.PAGES_CONTEXT = pagesContext

		await runWorkerStage({
			workers,
			stage: 'sync',
			messages: workers.map((worker) => ({
				worker,
				message: {
					type: 'sync',
					stage: 'sync',
					updates: titleUpdates
				}
			}))
		})
		if (state.RSS_ENABLED) {
			const feedPages = selectFeedPages(pages, state.RSS_OPTIONS || {})
			const pageIndex = new Map(pages.map((page, index) => [page, index]))
			feedIds = feedPages.map((page) => pageIndex.get(page)).filter((id) => id != null)
			if (feedIds.length) {
				feedAssignments = Array.from({ length: workers.length }, () => [])
				for (const id of feedIds) {
					feedAssignments[id % workers.length].push(id)
				}
			}
		}

		const renderToken = stageLogger.start('Rendering pages')
		completed = 0
		await runWorkerStage({
			workers,
			stage: 'render',
			messages: workers.map((worker, index) => ({
				worker,
				message: {
					type: 'render',
					stage: 'render',
					ids: assignments[index],
					feedIds: feedAssignments ? feedAssignments[index] : [],
					htmlStageDir,
					writeConcurrency
				}
			})),
			onProgress: (count) => {
				if (!logEnabled) return
				completed = count
				stageLogger.update(renderToken, `Rendering pages [${completed}/${totalPages}]`)
			},
			onResult: (result) => {
				if (!result || typeof result.id !== 'number') return
				const page = pages[result.id]
				if (!page) return
				if (result.scan) {
					renderScansById.set(result.id, result.scan)
				}
				const name = resolveOutputName(page)
				const outPath = htmlStageDir
					? (result.stagePath || resolve(htmlStageDir, `${name}.html`))
					: `${name}.html`
				htmlEntryNames.add(name)
				htmlEntries.push({ name, routePath: page.routePath, stagePath: outPath, source: 'rendered' })
				if (result.feedContent != null) {
					const key = page.path || page.routePath
					if (key) {
						rssContent.set(key, result.feedContent || '')
					}
				}
			}
		})
		stageLogger.end(renderToken)

		for (const [id, scan] of renderScansById.entries()) {
			const page = pages[id]
			if (!page || !scan) continue
			const name = resolveOutputName(page)
			const stagePath = htmlStageDir ? resolve(htmlStageDir, `${name}.html`) : `${name}.html`
			renderScans.set(stagePath, scan)
		}
		completedRun = true
	} finally {
		if (!keepWorkers || !completedRun) {
			await terminateWorkers(workers)
		}
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
		if (htmlEntryNames.has(outputName)) {
			continue
		}
		const html = await readFile(file.fullPath, 'utf-8')
		const outPath = htmlStageDir ? resolve(htmlStageDir, file.relativePath) : null
		if (outPath) {
			await ensureDir(dirname(outPath))
			await writeFile(outPath, html)
		}
		htmlEntryNames.add(outputName)
		htmlEntries.push({
			name: outputName,
			routePath: outputName === 'index'
				? '/'
				: outputName.endsWith('/index')
					? `/${outputName.slice(0, -'/index'.length)}/`
					: `/${outputName}`,
			stagePath: outPath,
			inputPath: file.fullPath,
			source: 'static'
		})
	}

	return {
		htmlEntries,
		htmlStageDir,
		pagesContext,
		rssContent,
		renderScans,
		renderScansById,
		workers: keepWorkers ? workers : null,
		assignments: keepWorkers ? assignments : null
	}
}

export const rewriteHtmlEntriesInWorkers = async ({
	pages = [],
	htmlStageDir,
	manifest,
	scanResult,
	renderScansById,
	onProgress,
	workers: existingWorkers = null,
	assignments: existingAssignments = null
}) => {
	const totalPages = pages.length
	if (!totalPages) return
	const useExisting = Array.isArray(existingWorkers) && Array.isArray(existingAssignments)
	const { workers, assignments } = useExisting
		? { workers: existingWorkers, assignments: existingAssignments }
		: createBuildWorkers(totalPages)
	try {
		if (!useExisting) {
			await runWorkerStage({
				workers,
				stage: 'setPagesLite',
				messages: workers.map((worker) => ({
					worker,
					message: {
						type: 'setPagesLite',
						stage: 'setPagesLite',
						pages
					}
				}))
			})
		}

		const entryModules = Array.isArray(scanResult?.entryModules) ? scanResult.entryModules : []
		const commonScripts = Array.isArray(scanResult?.commonScripts) ? scanResult.commonScripts : []
		const commonEntry = scanResult?.commonScriptEntry?.manifestKey
			? manifest?.[scanResult.commonScriptEntry.manifestKey] || manifest?.[`/${scanResult.commonScriptEntry.manifestKey}`]
			: null

		await runWorkerStage({
			workers,
			stage: 'rewrite',
			messages: workers.map((worker, index) => {
				const ids = assignments[index] || []
				const scans = {}
				if (renderScansById) {
					for (const id of ids) {
						const scan = renderScansById.get(id)
						if (scan) scans[id] = scan
					}
				}
				return {
					worker,
					message: {
						type: 'rewrite',
						stage: 'rewrite',
						ids,
						htmlStageDir,
						manifest,
						entryModules,
						commonScripts,
						commonEntry,
						scans
					}
				}
			}),
			onProgress: (count) => {
				if (typeof onProgress === 'function') {
					onProgress(count, totalPages)
				}
			}
		})
	} finally {
		if (!useExisting) {
			await terminateWorkers(workers)
		}
	}
}

export const rewriteBuildHtml = async ({
	htmlEntries,
	pages,
	htmlStageDir,
	scanResult,
	renderScansById,
	workers,
	assignments,
	manifest
}) => {
	const logEnabled = state.CURRENT_MODE === 'production' && cli.command === 'build' && !cli.CLI_VERBOSE
	const stageLogger = createStageLogger(logEnabled)
	const token = stageLogger.start('Rewriting HTML')
	try {
		await rewriteHtmlEntriesInWorkers({
			pages,
			htmlStageDir,
			manifest,
			scanResult,
			renderScansById,
			workers,
			assignments,
			onProgress: (done, total) => {
				stageLogger.update(token, `Rewriting HTML [${done}/${total}]`)
			}
		})
		await rewriteHtmlEntries(htmlEntries, manifest, scanResult)
	} finally {
		stageLogger.end(token)
	}
}

export const writeUnbundledHtml = async (htmlEntries) => {
	if (state.STATIC_DIR !== false && state.MERGED_ASSETS_DIR) {
		await preparePublicAssets({
			themeDir: state.THEME_ASSETS_DIR,
			userDir: state.USER_ASSETS_DIR,
			targetDir: state.MERGED_ASSETS_DIR
		})
	}
	await rm(state.DIST_DIR, { recursive: true, force: true })
	await mkdir(state.DIST_DIR, { recursive: true })
	if (state.STATIC_DIR !== false && state.STATIC_DIR) {
		await cp(state.STATIC_DIR, state.DIST_DIR, { recursive: true, dereference: true })
	}
	for (const entry of htmlEntries) {
		const name = entry?.name
		const stagePath = entry?.stagePath || entry?.inputPath
		if (!name || !stagePath) continue
		const distPath = resolve(state.DIST_DIR, `${name}.html`)
		await mkdir(dirname(distPath), { recursive: true })
		await copyFile(stagePath, distPath)
	}
}

export const runRsbuildBuild = async (inputs) => {
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
	const entryModules = Array.isArray(inputs.entryModules) ? inputs.entryModules : []
	const sourceEntries = {}
	const entryRecords = []
	let assetsEntryName = null
	for (const entry of entryModules.filter(Boolean).sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
		if (!entry.fsPath || !entry.manifestKey) continue
		const normalized = normalizePath(entry.fsPath)
		const entryName = makeInputKey(entry.kind || 'chunk', normalized)
		sourceEntries[entryName] = { import: normalized, html: false }
		entryRecords.push({ ...entry, entryName })
	}
	if (inputs.assetsEntryPath) {
		const normalized = normalizePath(inputs.assetsEntryPath)
		const entryName = makeInputKey('assets', normalized)
		sourceEntries[entryName] = { import: normalized, html: false }
		assetsEntryName = entryName
	}
	if (cli.CLI_VERBOSE && Object.keys(sourceEntries).length === 0) {
		console.log('Rsbuild pipeline: no wrapper entries detected (no module scripts/stylesheets found)')
	}
	let swEntryPath = null
	if (state.PWA_ENABLED) {
		swEntryPath = normalizePath(resolve(__dirname, 'client', 'sw.js'))
		if (swEntryPath) {
			sourceEntries.sw = {
				import: swEntryPath,
				html: false,
				filename: 'sw.js',
				runtime: false,
				chunkLoading: false,
				asyncChunks: false
			}
		}
	}
	if (Object.keys(sourceEntries).length === 0) {
		throw new Error('Rsbuild pipeline requires at least one script, stylesheet, asset, or service-worker entry')
	}
	const virtualModules = createMethanolVirtualModules()
	const publicDir = state.STATIC_DIR === false || !state.STATIC_DIR
		? false
		: { name: state.STATIC_DIR, copyOnBuild: true, watch: false }
	const baseConfig = {
		root: state.PAGES_DIR,
		logLevel: cli.CLI_VERBOSE ? 'info' : 'silent',
		source: {
			entry: sourceEntries,
			include: [
				state.PAGES_DIR,
				state.COMPONENTS_DIR,
				state.THEME_COMPONENTS_DIR,
				resolve(__dirname, 'client')
			].filter(Boolean)
		},
		output: {
			distPath: {
				root: state.DIST_DIR,
				js: 'assets',
				css: 'assets',
				jsAsync: 'assets',
				cssAsync: 'assets'
			},
			cleanDistPath: true,
			assetPrefix: state.BUILD_BASE || '/',
			dataUriLimit: 0,
			minify: true,
			legalComments: 'none'
		},
		server: {
			base: state.BUILD_BASE || '/',
			publicDir
		},
		resolve: {
			dedupe: ['refui', 'methanol']
		},
		tools: {
			htmlPlugin: false,
			swc: (config) => {
				config.jsc ||= {}
				config.jsc.transform ||= {}
				config.jsc.transform.react = {
					...(config.jsc.transform.react || {}),
					runtime: 'automatic',
					importSource: 'refui',
					development: false,
					throwIfNamespace: false
				}
				return config
			},
			rspack: (config) => {
				config.plugins ||= []
				config.plugins.push(new MethanolResolverPlugin(), virtualModules.plugin)
				config.optimization ||= {}
				config.optimization.runtimeChunk = false
				return config
			}
		}
	}
	const userConfig = await resolveUserRsbuildConfig('build')
	const finalConfig = userConfig ? mergeRsbuildConfig(baseConfig, userConfig) : baseConfig

	// Keep the pipeline deterministic: user config may extend the build but cannot relocate core outputs or entries.
	finalConfig.root = state.PAGES_DIR
	finalConfig.source = { ...(finalConfig.source || {}), entry: sourceEntries }
	finalConfig.output = {
		...(finalConfig.output || {}),
		distPath: {
			...((typeof finalConfig.output?.distPath === 'object' && finalConfig.output.distPath) || {}),
			root: state.DIST_DIR
		},
		cleanDistPath: true,
		dataUriLimit: 0
	}
	finalConfig.server = { ...(finalConfig.server || {}), publicDir }
	finalConfig.tools = { ...(finalConfig.tools || {}), htmlPlugin: false }

	const rsbuild = await createRsbuild({
		cwd: state.PAGES_DIR,
		callerName: 'methanol',
		config: finalConfig
	})
	const result = await rsbuild.build()
	try {
		const manifest = createAssetManifest({ entryRecords, stats: result.stats })
		const protectedJavaScript = new Set()
		for (const record of entryRecords.filter((entry) => entry.kind !== 'style')) {
			for (const file of entryAssetsFromStats(result.stats, record.entryName)?.js || []) {
				protectedJavaScript.add(file)
			}
		}
		const serviceWorkerJavaScript = entryAssetsFromStats(result.stats, 'sw')?.js || []
		if (state.PWA_ENABLED && (serviceWorkerJavaScript.length !== 1 || serviceWorkerJavaScript[0] !== 'sw.js')) {
			throw new Error('Rsbuild must emit the service worker as a standalone sw.js file')
		}
		for (const file of serviceWorkerJavaScript) {
			protectedJavaScript.add(file)
		}
		const unusedEntryNames = [
			...entryRecords.filter((entry) => entry.kind === 'style').map((entry) => entry.entryName),
			assetsEntryName
		].filter(Boolean)
		for (const entryName of unusedEntryNames) {
			for (const file of entryAssetsFromStats(result.stats, entryName)?.js || []) {
				if (!protectedJavaScript.has(file)) {
					await rm(resolve(state.DIST_DIR, file), { force: true })
				}
			}
		}
		return manifest
	} finally {
		stageLogger.end(token)
		await result.close()
	}
}
