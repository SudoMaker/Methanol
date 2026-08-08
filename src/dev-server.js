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
import { readFile } from 'fs/promises'
import { resolve, dirname, extname, join, basename, relative, isAbsolute } from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import chokidar from 'chokidar'
import fg from 'fast-glob'
import { createRsbuild, mergeRsbuildConfig } from '@rsbuild/core'
import { state, cli } from './state.js'
import { resolveBasePrefix, resolveUserRsbuildConfig } from './config.js'
import {
	buildComponentRegistry,
	buildComponentEntry,
	invalidateRegistryEntry,
	bumpComponentImportNonce,
	isComponentFile,
	isClientComponent,
	COMPONENT_EXTENSIONS
} from './components.js'
import { buildPagesContext, buildPageEntry, routePathFromFile } from './pages.js'
import { compilePageMdx, renderHtml } from './mdx.js'
import { DevErrorPage } from './templates/error-page.jsx'
import { HTMLRenderer } from './renderer.js'
import { MethanolRefurbishPlugin, MethanolResolverPlugin, createMethanolVirtualModules } from './rsbuild-plugins.js'
import { createAssetManifest } from './asset-manifest.js'
import { preparePublicAssets, updateAsset } from './public-assets.js'
import { createBuildWorkers, runWorkerStage, terminateWorkers } from './workers/build-pool.js'
import { virtualModuleDir } from './client/virtual-module/assets.js'
import { scanRenderedHtml, rewriteHtmlContent } from './html/worker-html.js'
import { style } from './logger.js'

const DEV_ENTRY_PATTERN = '**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx,css,svg,png,jpg,jpeg,gif,webp,avif,ico,woff,woff2,ttf,otf,eot,mp3,mp4,webm,wav,ogg,pdf}'
const DEV_ENTRY_IGNORE = [
	'**/node_modules/**',
	'.methanol/entries/**',
	'.methanol/html/**',
	'.methanol/virtual/**',
	'.methanol/assets-entry.js'
]

const entryNameFor = (value) => `source-${createHash('md5').update(value).digest('hex').slice(0, 12)}`

const collectDevEntries = async () => {
	const records = []
	const byPublicPath = new Set()
	const add = (fsPath, publicPath, kind = null, entryName = null) => {
		if (!fsPath || !publicPath || byPublicPath.has(publicPath)) return
		byPublicPath.add(publicPath)
		const name = entryName || entryNameFor(fsPath)
		records.push({
			entryName: name,
			fsPath,
			publicPath,
			manifestKey: publicPath.replace(/^\//, ''),
			kind: kind || (() => {
				const extension = extname(fsPath).toLowerCase()
				if (extension === '.css') return 'style'
				if (/^\.(?:[cm]?[jt]sx?)$/.test(extension)) return 'script'
				return 'asset'
			})()
		})
	}

	add(resolve(virtualModuleDir, 'inject.js'), '/.methanol_virtual_module/inject.js', 'script', 'methanol-client')
	const roots = [{ root: state.PAGES_DIR, prefix: '' }]
	for (const entry of state.SOURCES) {
		if (typeof entry.find !== 'string') continue
		roots.push({ root: entry.replacement, prefix: entry.find })
	}
	for (const { root, prefix } of roots) {
		if (!root || !existsSync(root)) continue
		const files = await fg(DEV_ENTRY_PATTERN, {
			cwd: root,
			absolute: true,
			onlyFiles: true,
			ignore: DEV_ENTRY_IGNORE
		})
		for (const path of files.sort()) {
			const relPath = relative(root, path).replace(/\\/g, '/')
			const publicPath = `${prefix || ''}/${relPath}`.replace(/\/+/g, '/')
			add(path, publicPath.startsWith('/') ? publicPath : `/${publicPath}`)
		}
	}

	const sourceEntries = Object.fromEntries(records.map((record) => [
		record.entryName,
		{ import: record.fsPath, html: false }
	]))
	return { records, sourceEntries }
}

const createDevManifestMaps = (manifest, records) => {
	const scriptMap = new Map()
	const styleMap = new Map()
	for (const record of records) {
		const entry = manifest[record.manifestKey]
		if (!entry?.file) continue
		if (record.kind === 'script') {
			scriptMap.set(record.publicPath, {
				file: entry.file,
				js: entry.js || null,
				css: entry.css || null
			})
		} else if (record.kind === 'style') {
			const cssFile = entry.css?.[0] || (entry.file.endsWith('.css') ? entry.file : null)
			if (cssFile) styleMap.set(record.publicPath, { file: cssFile, css: entry.css || null })
		}
	}
	return { scriptMap, styleMap }
}

export const runRsbuildDev = async () => {
	await resolveUserRsbuildConfig('dev')
	let handleHtmlRequest = null
	const initialEntries = await collectDevEntries()
	let currentEntries = initialEntries
	let devManifestCache = null
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
	const initialRegistry = await buildComponentRegistry()
	let components = initialRegistry.components
	const componentSources = new Map(initialRegistry.sources)
	let pagesContext = null
	let pagesContextToken = 0
	const setPagesContext = (next) => {
		pagesContext = next
		state.PAGES_CONTEXT = next
		pagesContextToken += 1
	}
	setPagesContext(await buildPagesContext({ compileAll: false }))
	const htmlCache = new Map()
	let htmlCacheEpoch = 0
	const virtualModules = createMethanolVirtualModules()
	const publicDir = state.STATIC_DIR === false || !state.STATIC_DIR
		? false
		: { name: state.STATIC_DIR, copyOnBuild: false, watch: false }
	const baseConfig = {
		root: state.PAGES_DIR,
		logLevel: 'info',
		source: {
			entry: initialEntries.sourceEntries,
			include: [
				state.PAGES_DIR,
				state.COMPONENTS_DIR,
				state.THEME_COMPONENTS_DIR,
				resolve(dirname(fileURLToPath(import.meta.url)), 'client')
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
			filenameHash: false,
			cleanDistPath: false,
			dataUriLimit: 0
		},
		dev: {
			hmr: true,
			liveReload: true
		},
		server: {
			base: state.BUILD_BASE || '/',
			publicDir,
			htmlFallback: false,
			setup: ({ server }) => {
				server.middlewares.use((req, res, next) => {
					if (!handleHtmlRequest) return next()
					return handleHtmlRequest(req, res, next)
				})
			}
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
					development: true,
					throwIfNamespace: false
				}
				return config
			},
			rspack: (config) => {
				config.plugins ||= []
				config.plugins.push(new MethanolResolverPlugin(), virtualModules.plugin, new MethanolRefurbishPlugin())
				config.optimization ||= {}
				config.optimization.runtimeChunk = 'single'
				const baseEntry = config.entry
				config.entry = async () => {
					const inherited = typeof baseEntry === 'function' ? await baseEntry() : baseEntry || {}
					currentEntries = await collectDevEntries()
					return { ...inherited, ...currentEntries.sourceEntries }
				}
				return config
			}
		}
	}
	const userConfig = await resolveUserRsbuildConfig('dev')
	const finalConfig = userConfig ? mergeRsbuildConfig(baseConfig, userConfig) : baseConfig
	finalConfig.root = state.PAGES_DIR
	finalConfig.source = { ...(finalConfig.source || {}), entry: initialEntries.sourceEntries }
	finalConfig.output = {
		...(finalConfig.output || {}),
		distPath: {
			...((typeof finalConfig.output?.distPath === 'object' && finalConfig.output.distPath) || {}),
			root: state.DIST_DIR
		},
		filenameHash: false,
		cleanDistPath: false,
		assetPrefix: state.BUILD_BASE || '/',
		dataUriLimit: 0
	}
	finalConfig.dev = {
		...(finalConfig.dev || {}),
		lazyCompilation: false
	}
	finalConfig.server = {
		...(finalConfig.server || {}),
		base: state.BUILD_BASE || '/',
		publicDir,
		htmlFallback: false
	}
	finalConfig.tools = { ...(finalConfig.tools || {}), htmlPlugin: false }
	const devBase = state.BUILD_BASE || '/'
	const devBasePrefix = devBase === '/' ? '' : devBase.slice(0, -1)
	if (state.STATIC_DIR !== false && state.MERGED_ASSETS_DIR) {
		await preparePublicAssets({
			themeDir: state.THEME_ASSETS_DIR,
			userDir: state.USER_ASSETS_DIR,
			targetDir: state.MERGED_ASSETS_DIR
		})
	}
	if (cli.CLI_PORT != null) {
		finalConfig.server = { ...(finalConfig.server || {}), port: cli.CLI_PORT }
	}
	if (cli.CLI_HOST !== null) {
		finalConfig.server = { ...(finalConfig.server || {}), host: cli.CLI_HOST }
	}
	const rsbuild = await createRsbuild({
		cwd: state.PAGES_DIR,
		callerName: 'methanol',
		config: finalConfig
	})
	const server = await rsbuild.createDevServer()

	if (state.MERGED_ASSETS_DIR && state.USER_ASSETS_DIR) {
		const assetWatcher = chokidar.watch(state.USER_ASSETS_DIR, {
			ignoreInitial: true
		})
		const handleAssetUpdate = (type, path) => {
			const relPath = relative(state.USER_ASSETS_DIR, path)
			enqueue(async () => {
				await updateAsset({
					type,
					path,
					relPath,
					themeDir: state.THEME_ASSETS_DIR,
					userDir: state.USER_ASSETS_DIR,
					targetDir: state.MERGED_ASSETS_DIR
				})
				reload()
			})
		}
		assetWatcher.on('add', (path) => handleAssetUpdate('add', path))
		assetWatcher.on('change', (path) => handleAssetUpdate('change', path))
		assetWatcher.on('unlink', (path) => handleAssetUpdate('unlink', path))
		assetWatcher.on('addDir', (path) => handleAssetUpdate('addDir', path))
		assetWatcher.on('unlinkDir', (path) => handleAssetUpdate('unlinkDir', path))
	}

	const invalidateHtmlCache = () => {
		htmlCacheEpoch += 1
		htmlCache.clear()
	}

	const logMdxError = (phase, error, page = null) => {
		const target = page?.path || page?.routePath || 'unknown file'
		console.error(style.red(`\n[methanol] ${phase} error in ${target}`))
		console.error(error?.stack || error)
	}
	const formatDevError = (error) => {
		if (!error) return 'Unknown error'
		if (typeof error === 'string') return error
		if (error?.stack) return error.stack
		if (error?.message) return error.message
		return String(error)
	}
	const sendDevError = async (res, error) => {
		const message = formatDevError(error)
		const basePrefix = devBasePrefix || ''
		const html = HTMLRenderer.serialize(
			DevErrorPage({ message, basePrefix })(HTMLRenderer)
		)
		res.statusCode = 500
		res.setHeader('Content-Type', 'text/html')
		res.end(html)
	}

	const invalidateReframeInject = () => {
		virtualModules.updateRegistry()
	}
	const invalidatePagesIndex = () => {
		virtualModules.updatePages()
		virtualModules.updateRegistry()
	}

	const transformDevHtml = async (html, routePath) => {
		const scanned = await scanRenderedHtml(html, routePath, { rewriteInline: false })
		const stats = await server.environments.web.getStats()
		const statsHash = stats?.hash || stats?.stats?.map((item) => item.hash).filter(Boolean).join(':') || null
		if (!statsHash || devManifestCache?.hash !== statsHash) {
			const manifest = createAssetManifest({
				entryRecords: currentEntries.records,
				stats
			})
			devManifestCache = {
				hash: statsHash,
				manifest,
				...createDevManifestMaps(manifest, currentEntries.records)
			}
		}
		const { manifest, scriptMap, styleMap } = devManifestCache
		return rewriteHtmlContent(
			scanned.html,
			scanned.plan,
			routePath,
			resolveBasePrefix(),
			manifest,
			scriptMap,
			styleMap,
			new Set(),
			null
		)
	}

	const refreshPagesContext = async () => {
		setPagesContext(await buildPagesContext({ compileAll: false }))
	}
	const resolveStaticCandidate = (baseDir, pathname) => {
		if (!baseDir) return null
		const root = resolve(baseDir)
		const target = resolve(root, pathname.replace(/^\//, ''))
		const relPath = relative(root, target)
		if (
			isAbsolute(relPath) ||
			relPath === '..' ||
			relPath.startsWith('../') ||
			relPath.startsWith('..\\')
		) return null
		return target
	}

	const prebuildHtmlCache = async (token) => {
		if (!pagesContext || token !== pagesContextToken) return
		const pages = pagesContext.pagesAll || pagesContext.pages || []
		if (!pages.length) return
		const { workers, assignments } = createBuildWorkers(pages.length, { command: 'dev' })
		const excludedRoutes = Array.from(pagesContext.excludedRoutes || [])
		const excludedDirs = Array.from(pagesContext.excludedDirs || [])
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
			if (token !== pagesContextToken) return

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
				collect: (message) => message.updates || []
			})
			if (token !== pagesContextToken) return

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
			invalidatePagesIndex()
			invalidateHtmlCache()
			const renderEpoch = htmlCacheEpoch

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
			if (token !== pagesContextToken) return

			const rendered = []
			await runWorkerStage({
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
				onResult: (result) => {
					if (result) rendered.push(result)
				}
			})
			if (token !== pagesContextToken || renderEpoch !== htmlCacheEpoch) return
			for (const item of rendered) {
				const page = pages[item.id]
				if (!page) continue
				htmlCache.set(page.routePath, {
					html: item.html,
					path: page.path,
					epoch: renderEpoch,
					token
				})
			}
		} finally {
			await terminateWorkers(workers)
		}
	}

	const runInitialCompile = async () => {
		const token = pagesContextToken
		try {
			invalidateHtmlCache()
			await prebuildHtmlCache(token)
			if (token !== pagesContextToken) {
				return
			}
			reload()
		} catch (err) {
			console.error(err)
		}
	}

	const resolvePageFile = (routePath) => {
		let name = 'index'
		if (routePath && routePath !== '/') {
			if (routePath.endsWith('/')) {
				name = `${routePath.slice(1, -1)}/index`
			} else {
				name = routePath.slice(1)
			}
		}
		const mdxPath = resolve(state.PAGES_DIR, `${name}.mdx`)
		if (existsSync(mdxPath)) return mdxPath
		const mdPath = resolve(state.PAGES_DIR, `${name}.md`)
		if (existsSync(mdPath)) return mdPath
		return mdxPath
	}

	const resolveHtmlCandidates = (pathname) => {
		const candidates = []
		if (pathname === '/' || pathname === '') {
			candidates.push('/index.html')
		} else if (pathname.endsWith('/')) {
			candidates.push(`${pathname}index.html`)
		} else if (pathname.endsWith('.html')) {
			candidates.push(pathname)
		} else {
			candidates.push(`${pathname}.html`)
			candidates.push(`${pathname}/index.html`)
		}
		return candidates.map((candidate) =>
			resolve(state.PAGES_DIR, candidate.replace(/^\//, ''))
		)
	}

	const shouldServeHtml = (relativePath, requestedPath, hasMdx) => {
		if (hasMdx) return false
		const baseName = basename(relativePath, '.html')
		if (baseName.startsWith('_') || baseName.startsWith('.')) return false
		const excludedDirs = pagesContext.excludedDirs
		if (excludedDirs?.size) {
			const dir = relativePath.split('/').slice(0, -1).join('/')
			for (const excludedDir of excludedDirs) {
				if (!excludedDir) return false
				if (dir === excludedDir || dir.startsWith(`${excludedDir}/`)) {
					return false
				}
			}
		}
		const excludedRoutes = pagesContext.excludedRoutes
		if (excludedRoutes?.has(requestedPath)) return false
		const excludedDirPaths = pagesContext.excludedDirPaths
		if (excludedDirPaths?.size) {
			for (const dirPath of excludedDirPaths) {
				if (requestedPath === dirPath || requestedPath.startsWith(`${dirPath}/`)) {
					return false
				}
			}
		}
		return true
	}

	const htmlMiddleware = async (req, res, next) => {
		if (!req.url || req.method !== 'GET') {
			return next()
		}

		const url = new URL(req.url, 'http://methanol')
		let pathname = url.pathname
		try {
			pathname = decodeURIComponent(pathname)
		} catch {}
		const originalPathname = pathname
		if (devBase !== '/') {
			const baseNoSlash = devBasePrefix
			if (originalPathname === baseNoSlash) {
				pathname = '/'
			} else if (originalPathname.startsWith(devBase)) {
				pathname = originalPathname.slice(devBase.length - 1)
			} else {
				return next()
			}
		}

		if (pathname.startsWith('/rsbuild-hmr') || pathname.startsWith('/__rsbuild')) {
			return next()
		}

		const accept = req.headers.accept || ''
		if (!pathname.endsWith('.html') && !accept.includes('text/html')) {
			return next()
		}

		let routePath = pathname
		if (routePath.endsWith('.html')) {
			routePath = routePath.slice(0, -'.html'.length)
			if (routePath === '') {
				routePath = '/'
			}
		}
		const requestedPath = routePath
		if (pathname.includes('.') && !pathname.endsWith('.html')) {
			if (!pagesContext?.pagesByRoute?.has(requestedPath)) {
				const pageCandidate = resolveStaticCandidate(state.PAGES_DIR, pathname)
				if (pageCandidate && existsSync(pageCandidate)) {
					return next()
				}
				const staticCandidate = resolveStaticCandidate(state.STATIC_DIR, pathname)
				if (staticCandidate && existsSync(staticCandidate)) {
					return next()
				}
			}
		}
		const isExcludedPath = () => {
			const excludedRoutes = pagesContext.excludedRoutes
			if (excludedRoutes?.has(requestedPath)) return true
			const excludedDirPaths = pagesContext.excludedDirPaths
			if (excludedDirPaths?.size) {
				for (const dirPath of excludedDirPaths) {
					if (requestedPath === dirPath || requestedPath.startsWith(`${dirPath}/`)) {
						return true
					}
				}
			}
			return false
		}
		const notFoundPage = pagesContext.pagesByRoute.get('/404')
		let pageMeta = pagesContext.pagesByRoute.get(requestedPath)
		let path = pageMeta?.path || resolvePageFile(requestedPath)
		const hasMdx = Boolean(pageMeta) || existsSync(path)
		let status = 200
		let renderRoutePath = requestedPath

		if (!hasMdx) {
			const candidates = resolveHtmlCandidates(pathname)
			for (const candidate of candidates) {
				if (!existsSync(candidate)) continue
				const relativePath = relative(state.PAGES_DIR, candidate).replace(/\\/g, '/')
				if (relativePath.startsWith('..')) {
					continue
				}
				if (!shouldServeHtml(relativePath, requestedPath, hasMdx)) {
					continue
				}
				try {
					const html = await readFile(candidate, 'utf-8')
					const transformed = await transformDevHtml(html, requestedPath)
					res.statusCode = 200
					res.setHeader('Content-Type', 'text/html')
					res.end(transformed)
					return
				} catch (err) {
					console.error(err)
					await sendDevError(res, err)
					return
				}
			}
		}

		if (isExcludedPath()) {
			if (notFoundPage) {
				path = notFoundPage.path
				renderRoutePath = '/404'
				status = 404
			} else {
				return next()
			}
		} else if (!pageMeta && !existsSync(path)) {
			if (notFoundPage) {
				path = notFoundPage.path
				renderRoutePath = '/404'
				status = 404
			} else {
				return next()
			}
		} else if (requestedPath.endsWith('/index')) {
			renderRoutePath = requestedPath.slice(0, -5) // remove last 'index'
		}

		try {
			const renderEpoch = htmlCacheEpoch
			const cacheEntry = htmlCache.get(renderRoutePath)
			if (
				cacheEntry &&
				cacheEntry.path === path &&
				cacheEntry.epoch === htmlCacheEpoch &&
				cacheEntry.token === pagesContextToken
			) {
				res.statusCode = status
				res.setHeader('Content-Type', 'text/html')
				res.end(await transformDevHtml(cacheEntry.html, renderRoutePath))
				return
			}

			pageMeta ??= pagesContext.getPageByRoute(renderRoutePath, { path })

			let html = ''
			try {
				html = await enqueueRender(() =>
					renderHtml({
						routePath: renderRoutePath,
						path,
						components: {
							...themeComponents,
							...components
						},
						pagesContext,
						pageMeta
					})
				)
			} catch (err) {
				logMdxError('MDX render', err, pageMeta || { path, routePath: renderRoutePath })
				await sendDevError(res, err)
				return
			}
			if (renderEpoch === htmlCacheEpoch) {
				htmlCache.set(renderRoutePath, {
					html,
					path,
					epoch: renderEpoch,
					token: pagesContextToken
				})
			}
			res.statusCode = status
			res.setHeader('Content-Type', 'text/html')
			res.end(await transformDevHtml(html, renderRoutePath))
		} catch (err) {
			logMdxError('MDX render', err, pageMeta || { path, routePath: renderRoutePath })
			await sendDevError(res, err)
		}
	}

	handleHtmlRequest = htmlMiddleware

	await server.listen()

	let queue = Promise.resolve()
	const enqueue = (task) => {
		queue = queue.then(task).catch((err) => {
			console.error(err)
		})
		return queue
	}

	let renderQueue = Promise.resolve()
	const enqueueRender = (task) => {
		const next = renderQueue.then(task, task)
		renderQueue = next.catch(() => {})
		return next
	}

	const reload = () => {
		server.sockWrite('static-changed')
	}

	runInitialCompile()

	const refreshPages = async ({ compilePath = null } = {}) => {
		await refreshPagesContext()
		if (compilePath) {
			const page = pagesContext.pagesAll?.find?.((entry) => entry.path === compilePath)
				|| pagesContext.pages?.find?.((entry) => entry.path === compilePath)
				|| null
			if (page?.content?.trim()) {
				try {
					await compilePageMdx(page, pagesContext, {
						lazyPagesTree: true,
						refreshPagesTree: false
					})
					page.mdxComponent = null
				} catch (err) {
					logMdxError('MDX compile', err, page)
					page.mdxComponent = null
				}
			}
		}
		invalidatePagesIndex()
		invalidateHtmlCache()
		reload()
	}

	const getExportName = (path) => basename(path).split('.')[0]

	const findComponentExt = (dir, exportName) => {
		for (const ext of COMPONENT_EXTENSIONS) {
			if (
				existsSync(join(dir, `${exportName}${ext}`)) ||
				existsSync(join(dir, `${exportName}.client${ext}`)) ||
				existsSync(join(dir, `${exportName}.static${ext}`))
			) {
				return ext
			}
		}
		return null
	}

	const updateComponentEntry = async (path, { fallback = false } = {}) => {
		bumpComponentImportNonce()
		const exportName = getExportName(path)
		const dir = dirname(path)
		let ext = extname(path)
		let { component, hasClient, staticPath } = await buildComponentEntry({
			dir,
			exportName,
			ext
		})
		if (!component && fallback) {
			ext = findComponentExt(dir, exportName)
			if (ext) {
				;({ component, hasClient, staticPath } = await buildComponentEntry({
					dir,
					exportName,
					ext
				}))
			}
		}
		if (!component) {
			delete components[exportName]
			componentSources.delete(exportName)
			invalidateRegistryEntry(exportName)
			return { hasClient: false }
		}
		if (!hasClient) {
			invalidateRegistryEntry(exportName)
		}
		components[exportName] = component
		if (staticPath) {
			componentSources.set(exportName, staticPath)
		}
		return { hasClient }
	}

	const pageWatchPaths = [state.PAGES_DIR, state.THEME_PAGES_DIR].filter(Boolean)
	const pageWatcher = chokidar.watch(pageWatchPaths, {
		ignoreInitial: true
	})

	const PAGE_UPDATE_DEBOUNCE_MS = 30
	const pageUpdateTimers = new Map()

	const schedulePageUpdate = (path, kind) => {
		const existing = pageUpdateTimers.get(path)
		if (existing?.timer) {
			clearTimeout(existing.timer)
		}
		const entry = {
			kind,
			timer: setTimeout(() => {
				pageUpdateTimers.delete(path)
				enqueue(() => handlePageUpdate(path, kind))
			}, PAGE_UPDATE_DEBOUNCE_MS)
		}
		pageUpdateTimers.set(path, entry)
	}

	const resolveWatchedSource = (path) => {
		const inUserPages = routePathFromFile(path, state.PAGES_DIR)
		if (inUserPages) {
			return { pagesDir: state.PAGES_DIR, source: 'user', routePath: inUserPages }
		}
		if (state.THEME_PAGES_DIR) {
			const inThemePages = routePathFromFile(path, state.THEME_PAGES_DIR)
			if (inThemePages) {
				return { pagesDir: state.THEME_PAGES_DIR, source: 'theme', routePath: inThemePages }
			}
		}
		return null
	}

	const updatePageEntry = async (path, resolved) => {
		if (!pagesContext || !resolved) return false
		pagesContext.clearDerivedTitle?.(path)
		const nextEntry = await buildPageEntry({
			path,
			pagesDir: resolved.pagesDir,
			source: resolved.source
		})
		if (!nextEntry) return false
		const prevEntry = pagesContext.pagesAll?.find?.((page) => page.path === path)
			|| pagesContext.pages?.find?.((page) => page.path === path)
			|| null
		if (!prevEntry) return false
		if (prevEntry.exclude !== nextEntry.exclude) return false
		if (prevEntry.isIndex !== nextEntry.isIndex || prevEntry.dir !== nextEntry.dir) return false
		Object.assign(prevEntry, nextEntry)
		prevEntry.mdxComponent = null
		prevEntry.toc = null
		pagesContext.refreshPagesTree?.()
		pagesContext.refreshLanguages?.()
		if (prevEntry.content && prevEntry.content.trim().length) {
			try {
				await compilePageMdx(prevEntry, pagesContext, {
					lazyPagesTree: true,
					refreshPagesTree: false
				})
				// Avoid caching a potentially stale render; recompile on request.
				prevEntry.mdxComponent = null
			} catch (err) {
				logMdxError('MDX compile', err, prevEntry)
				prevEntry.mdxComponent = null
			}
		}
		return true
	}

	const isUserHeadAsset = (path) => {
		const name = basename(path)
		if (name !== 'style.css' && name !== 'index.js' && name !== 'index.ts') {
			return false
		}
		const root = resolve(state.PAGES_DIR || '')
		return root && resolve(dirname(path)) === root
	}

	const handlePageUpdate = async (path, kind) => {
		if (isUserHeadAsset(path)) {
			invalidateHtmlCache()
			reload()
			return
		}
		const resolved = resolveWatchedSource(path)
		if (kind === 'unlink') {
			if (resolved?.routePath) {
				htmlCache.delete(resolved.routePath)
			} else {
				return
			}
			await refreshPages()
			return
		}
		const updated = await updatePageEntry(path, resolved)
		if (updated) {
			invalidatePagesIndex()
			invalidateHtmlCache()
			reload()
			return
		}
		if (!resolved?.routePath) {
			return
		}
		await refreshPages({ compilePath: kind === 'add' ? path : null })
	}

	pageWatcher.on('change', (path) => {
		schedulePageUpdate(path, 'change')
	})

	pageWatcher.on('add', (path) => {
		schedulePageUpdate(path, 'add')
	})
	pageWatcher.on('unlink', (path) => {
		schedulePageUpdate(path, 'unlink')
	})
	pageWatcher.on('addDir', () => {
		enqueue(refreshPages)
	})

	pageWatcher.on('unlinkDir', () => {
		enqueue(refreshPages)
	})

	const componentWatcher = chokidar.watch(state.COMPONENTS_DIR, {
		ignoreInitial: true
	})

	componentWatcher.on('add', (path) => {
		if (!isComponentFile(path)) {
			return
		}
		if (isClientComponent(path)) {
			enqueue(async () => {
				const { hasClient } = await updateComponentEntry(path)
				if (hasClient) {
					invalidateReframeInject()
				}
				invalidateHtmlCache()
				reload()
			})
			return
		}
		enqueue(async () => {
			const { hasClient } = await updateComponentEntry(path)
			invalidateHtmlCache()
			if (hasClient) {
				invalidateReframeInject()
			}
			reload()
		})
	})

	componentWatcher.on('change', (path) => {
		if (!isComponentFile(path)) {
			return
		}
		if (isClientComponent(path)) {
			enqueue(async () => {
				await updateComponentEntry(path)
				invalidateHtmlCache()
			})
			return
		}
		enqueue(async () => {
			const { hasClient } = await updateComponentEntry(path)
			invalidateHtmlCache()
			if (hasClient) {
				invalidateReframeInject()
			}
			reload()
		})
	})

	componentWatcher.on('unlink', (path) => {
		if (!isComponentFile(path)) return
		if (isClientComponent(path)) {
			enqueue(async () => {
				await updateComponentEntry(path, { fallback: true })
				invalidateReframeInject()
				invalidateHtmlCache()
				reload()
			})
			return
		}
		const exportName = getExportName(path)
		const currentSource = componentSources.get(exportName)
		if (currentSource && currentSource !== path && existsSync(currentSource)) {
			return
		}
		enqueue(async () => {
			const { hasClient } = await updateComponentEntry(path, {
				fallback: true
			})
			invalidateHtmlCache()
			if (hasClient) {
				invalidateReframeInject()
			}
			reload()
		})
	})
}
