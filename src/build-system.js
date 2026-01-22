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
import { writeFile, mkdir, rm, readFile, readdir, stat } from 'fs/promises'
import { resolve, dirname, join, basename } from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { build as viteBuild, mergeConfig, normalizePath } from 'vite'
import { state, cli } from './state.js'
import { resolveUserViteConfig } from './config.js'
import { buildPagesContext } from './pages.js'
import { selectFeedPages } from './feed.js'
import { buildComponentRegistry } from './components.js'
import { createBuildWorkers, runWorkerStage, terminateWorkers } from './workers/build-pool.js'
import { methanolResolverPlugin } from './vite-plugins.js'
import { createStageLogger } from './stage-logger.js'
import { preparePublicAssets } from './public-assets.js'
export { scanHtmlEntries, rewriteHtmlEntries } from './html/build-html.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const ensureDir = async (dir) => {
	await mkdir(dir, { recursive: true })
}

const ensureSwEntry = async () => {
	const entriesDir = resolve(resolveMethanolDir(), ENTRY_DIR)
	await ensureDir(entriesDir)
	const swEntryPath = resolve(entriesDir, 'sw-entry.js')
	const swSource = normalizePath(resolve(__dirname, 'client', 'sw.js'))
	await writeFile(swEntryPath, `import ${JSON.stringify(swSource)}\n`)
	return swEntryPath
}

const INLINE_DIR = 'inline'
const ENTRY_DIR = 'entries'

const resolveMethanolDir = () => resolve(state.PAGES_DIR, '.methanol')

const isHtmlFile = (name) => name.endsWith('.html')
const collectHtmlFiles = async (dir, basePath = '') => {
	const entries = await readdir(dir)
	const files = []
	for (const entry of entries.sort()) {
		if (entry.startsWith('.') || entry.startsWith('_')) {
			continue
		}
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

const hashKey = (value) =>
	createHash('md5').update(value).digest('hex')

const makeInputKey = (prefix, value) => `${prefix}-${hashKey(value).slice(0, 12)}`

export const buildHtmlEntries = async (options = {}) => {
	const keepWorkers = Boolean(options.keepWorkers)
	await resolveUserViteConfig('build') // Prepare `base`
	const htmlStageDir = state.INTERMEDIATE_DIR
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
	const htmlWrites = []
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
					cacheHtml: !htmlStageDir
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
				const html = result.html
				const name = resolveOutputName(page)
				const outPath = htmlStageDir ? resolve(htmlStageDir, `${name}.html`) : `${name}.html`
				htmlEntryNames.add(name)
				htmlEntries.push({ name, routePath: page.routePath, stagePath: outPath, source: 'rendered' })
				if (htmlStageDir) {
					htmlWrites.push(
						(async () => {
							await ensureDir(dirname(outPath))
							await writeFile(outPath, html)
						})()
					)
				}
				if (result.feedContent != null) {
					const key = page.path || page.routePath
					if (key) {
						rssContent.set(key, result.feedContent || '')
					}
				}
			}
		})
		stageLogger.end(renderToken)

		if (htmlWrites.length) {
			await Promise.all(htmlWrites)
		}

		const scanToken = stageLogger.start('Scanning HTML')
		completed = 0
		await runWorkerStage({
			workers,
			stage: 'scan',
			messages: workers.map((worker, index) => ({
				worker,
				message: {
					type: 'scan',
					stage: 'scan',
					ids: assignments[index],
					htmlStageDir
				}
			})),
			onProgress: (count) => {
				if (!logEnabled) return
				completed = count
				stageLogger.update(scanToken, `Scanning HTML [${completed}/${totalPages}]`)
			},
			onResult: (result) => {
				if (result?.stagePath && result?.scan) {
					renderScans.set(result.stagePath, result.scan)
				}
				if (typeof result?.id === 'number' && result?.scan) {
					renderScansById.set(result.id, result.scan)
				}
			}
		})
		stageLogger.end(scanToken)
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

export const runViteBuild = async (inputs) => {
	const logEnabled = state.CURRENT_MODE === 'production' && cli.command === 'build' && !cli.CLI_VERBOSE
	const stageLogger = createStageLogger(logEnabled)
	const token = stageLogger.start('Building bundle')
	const rewriteOptions = inputs?.rewrite || null
	let manifestData = null
	let bundleEnded = false
	const endBundleStage = () => {
		if (bundleEnded) return
		bundleEnded = true
		stageLogger.end(token)
	}

	if (state.STATIC_DIR !== false && state.MERGED_ASSETS_DIR) {
		await preparePublicAssets({
			themeDir: state.THEME_ASSETS_DIR,
			userDir: state.USER_ASSETS_DIR,
			targetDir: state.MERGED_ASSETS_DIR
		})
	}
	const copyPublicDirEnabled = state.STATIC_DIR !== false
	const entryModules = Array.isArray(inputs?.entryModules) ? inputs.entryModules : []
	const entryInputs = entryModules
		.filter((entry) => entry && entry.kind !== 'style')
		.map((entry) => entry.fsPath)
		.filter(Boolean)
		.sort()
	const htmlEntries = Array.isArray(inputs?.htmlEntries) ? inputs.htmlEntries : []
	const htmlInputs = htmlEntries
		.filter((entry) => entry?.source === 'static' && entry.inputPath)
		.map((entry) => entry.inputPath)
		.sort()
	if (cli.CLI_VERBOSE && entryInputs.length === 0) {
		console.log('Vite pipeline: no wrapper entries detected (no module scripts/stylesheets found)')
	}
	const rollupInput = {}
	for (const entryPath of entryInputs) {
		const normalized = normalizePath(entryPath)
		rollupInput[makeInputKey('chunk', normalized)] = normalized
	}
	for (const htmlPath of htmlInputs) {
		const normalized = normalizePath(htmlPath)
		rollupInput[makeInputKey('html', normalized)] = normalized
	}
	let swEntryPath = null
	if (state.PWA_ENABLED) {
		swEntryPath = await ensureSwEntry()
		if (swEntryPath) {
			const normalized = normalizePath(swEntryPath)
			rollupInput['sw'] = normalized
		}
	}
	const baseConfig = {
		configFile: false,
		root: state.PAGES_DIR,
		appType: 'custom',
		publicDir: state.STATIC_DIR === false ? false : state.STATIC_DIR,
		logLevel: cli.CLI_VERBOSE ? 'info' : 'silent',
		build: {
			outDir: state.DIST_DIR,
			emptyOutDir: true,
			rollupOptions: {
				input: rollupInput,
				output: {
					entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js')
				}
			},
			manifest: true,
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
		plugins: [methanolResolverPlugin()]
	}
	const userConfig = await resolveUserViteConfig('build')
	const finalConfig = userConfig ? mergeConfig(baseConfig, userConfig) : baseConfig

	// Keep the pipeline deterministic: do not let user configs override the build root/output/inputs.
	finalConfig.root = state.PAGES_DIR
	finalConfig.appType = 'custom'
	finalConfig.publicDir = state.STATIC_DIR === false ? false : state.STATIC_DIR
	finalConfig.build = {
		...(finalConfig.build || {}),
		outDir: state.DIST_DIR,
		emptyOutDir: true,
		manifest: true,
		copyPublicDir: copyPublicDirEnabled,
		rollupOptions: {
			...((finalConfig.build && finalConfig.build.rollupOptions) || {}),
			input: rollupInput,
			output: (() => {
				const existing = finalConfig.build?.rollupOptions?.output
				const outputConfig = Array.isArray(existing) ? existing[0] || {} : existing || {}
				return {
					...outputConfig,
					entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js')
				}
			})()
		}
	}

	const manifestFileName = typeof finalConfig.build?.manifest === 'string'
		? finalConfig.build.manifest
		: '.vite/manifest.json'
	const manifestPath = resolve(state.DIST_DIR, manifestFileName.replace(/^\//, ''))
	let rewriteDone = false
	const loadManifestFromDisk = async () => {
		if (!existsSync(manifestPath)) return null
		const raw = await readFile(manifestPath, 'utf-8')
		return JSON.parse(raw)
	}
	const runRewrite = async () => {
		if (!rewriteOptions || rewriteDone) return
		endBundleStage()
		const rewriteToken = logEnabled ? stageLogger.start('Rewriting HTML') : null
		try {
			await rewriteHtmlEntriesInWorkers({
				...rewriteOptions,
				manifest: manifestData,
				onProgress: (done, total) => {
					if (!rewriteToken) return
					stageLogger.update(rewriteToken, `Rewriting HTML [${done}/${total}]`)
				}
			})
		} finally {
			rewriteDone = true
			if (rewriteToken) {
				stageLogger.end(rewriteToken)
			}
		}
	}

	const postBundlePlugin = {
		name: 'methanol:post-bundle',
		apply: 'build',
		enforce: 'post',
		async writeBundle() {
			if (manifestData) {
				await runRewrite()
				return
			}
			const parsed = await loadManifestFromDisk()
			if (!parsed) return
			manifestData = parsed
			await runRewrite()
		},
		async closeBundle() {
			if (manifestData) {
				await runRewrite()
				return
			}
			const parsed = await loadManifestFromDisk()
			if (!parsed) return
			manifestData = parsed
			await runRewrite()
		}
	}

	finalConfig.plugins = [...(finalConfig.plugins || []), postBundlePlugin]

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
	endBundleStage()
	const methanolManifestDir = resolve(state.PAGES_DIR, '.methanol')
	const methanolManifestPath = resolve(methanolManifestDir, 'manifest.json')
	try {
		const parsed = manifestData || JSON.parse(await readFile(manifestPath, 'utf-8'))
		await ensureDir(methanolManifestDir)
		await writeFile(methanolManifestPath, JSON.stringify(parsed, null, 2))
		await rm(manifestPath, { force: true })
		const manifestDir = dirname(manifestPath)
		if (basename(manifestDir) === '.vite') {
			await rm(manifestDir, { recursive: true, force: true })
		}
		return parsed
	} catch (error) {
		if (cli.CLI_VERBOSE) {
			console.log(`Vite pipeline: failed to read manifest at ${manifestPath}`)
		}
		return {}
	}
}
