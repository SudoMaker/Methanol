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
import { resolve, dirname, extname, join, basename, relative } from 'path'
import { fileURLToPath } from 'url'
import chokidar from 'chokidar'
import { createServer, mergeConfig } from 'vite'
import { refurbish } from 'refurbish/vite'
import { state, cli } from './state.js'
import { resolveUserViteConfig } from './config.js'
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
import { methanolResolverPlugin } from './vite-plugins.js'
import { preparePublicAssets, updateAsset } from './public-assets.js'

export const runViteDev = async () => {
	const baseFsAllow = [state.ROOT_DIR, state.USER_THEME.root].filter(Boolean)
	if (state.MERGED_ASSETS_DIR) {
		baseFsAllow.push(state.MERGED_ASSETS_DIR)
	}
	const baseConfig = {
		configFile: false,
		root: state.PAGES_DIR,
		appType: 'mpa',
		publicDir: state.STATIC_DIR === false ? false : state.STATIC_DIR,
		server: {
			fs: {
				allow: baseFsAllow
			}
		},
		esbuild: {
			jsx: 'automatic',
			jsxImportSource: 'refui'
		},
		resolve: {
			dedupe: ['refui', 'methanol']
		},
		plugins: [methanolResolverPlugin(), refurbish()]
	}
	const userConfig = await resolveUserViteConfig('serve')
	const finalConfig = userConfig ? mergeConfig(baseConfig, userConfig) : baseConfig
	const devBase = state.VITE_BASE || '/'
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
	if (baseFsAllow.length) {
		const fsConfig = finalConfig.server?.fs || {}
		const allow = Array.isArray(fsConfig.allow) ? fsConfig.allow : []
		for (const dir of baseFsAllow) {
			if (!allow.includes(dir)) {
				allow.push(dir)
			}
		}
		finalConfig.server = {
			...(finalConfig.server || {}),
			fs: {
				...fsConfig,
				allow
			}
		}
	}
	const server = await createServer(finalConfig)

	if (state.MERGED_ASSETS_DIR && state.USER_ASSETS_DIR) {
		const assetWatcher = chokidar.watch(state.USER_ASSETS_DIR, {
			ignoreInitial: true
		})
		const handleAssetUpdate = (type, filePath) => {
			const relPath = relative(state.USER_ASSETS_DIR, filePath)
			enqueue(async () => {
				await updateAsset({
					type,
					filePath,
					relPath,
					themeDir: state.THEME_ASSETS_DIR,
					userDir: state.USER_ASSETS_DIR,
					targetDir: state.MERGED_ASSETS_DIR
				})
			})
		}
		assetWatcher.on('add', (filePath) => handleAssetUpdate('add', filePath))
		assetWatcher.on('change', (filePath) => handleAssetUpdate('change', filePath))
		assetWatcher.on('unlink', (filePath) => handleAssetUpdate('unlink', filePath))
	}

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
	const initialRegistry = await buildComponentRegistry()
	let components = initialRegistry.components
	const componentSources = new Map(initialRegistry.sources)
	let pagesContext = null
	let pagesContextToken = 0
	const setPagesContext = (next) => {
		pagesContext = next
		pagesContextToken += 1
	}
	setPagesContext(await buildPagesContext({ compileAll: false }))
	const htmlCache = new Map()
	let htmlCacheEpoch = 0

	const invalidateHtmlCache = () => {
		htmlCacheEpoch += 1
		htmlCache.clear()
	}

	const refreshPagesContext = async () => {
		setPagesContext(await buildPagesContext({ compileAll: false }))
	}

	const runInitialCompile = async () => {
		const token = pagesContextToken
		try {
			const nextContext = await buildPagesContext({ compileAll: true })
			if (token !== pagesContextToken) {
				return
			}
			setPagesContext(nextContext)
			invalidateHtmlCache()
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

		if (pathname.startsWith('/@vite') || pathname.startsWith('/__vite')) {
			return next()
		}

		if (pathname.includes('.') && !pathname.endsWith('.html')) {
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
		let filePath = pageMeta?.filePath || resolvePageFile(requestedPath)
		const hasMdx = Boolean(pageMeta) || existsSync(filePath)
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
					const candidateUrl = devBasePrefix
						? `${devBasePrefix}/${relativePath}`
						: `/${relativePath}`
					const transformed = await server.transformIndexHtml(candidateUrl, html)
					res.statusCode = 200
					res.setHeader('Content-Type', 'text/html')
					res.end(transformed)
					return
				} catch (err) {
					console.error(err)
					res.statusCode = 500
					res.end('Internal Server Error')
					return
				}
			}
		}

		if (isExcludedPath()) {
			if (notFoundPage) {
				filePath = notFoundPage.filePath
				renderRoutePath = '/404'
				status = 404
			} else {
				return next()
			}
		} else if (requestedPath === '/404' && notFoundPage) {
			filePath = notFoundPage.filePath
			renderRoutePath = '/404'
			status = 404
		} else if (!pageMeta && !existsSync(filePath)) {
			if (notFoundPage) {
				filePath = notFoundPage.filePath
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
			if (cacheEntry && cacheEntry.filePath === filePath && cacheEntry.epoch === htmlCacheEpoch) {
				res.statusCode = status
				res.setHeader('Content-Type', 'text/html')
				res.end(cacheEntry.html)
				return
			}

			pageMeta ??= pagesContext.getPageByRoute(renderRoutePath, { filePath })

			const html = await renderHtml({
				routePath: renderRoutePath,
				filePath,
				components: {
					...themeComponents,
					...components
				},
				pagesContext,
				pageMeta
			})
			if (renderEpoch === htmlCacheEpoch) {
				htmlCache.set(renderRoutePath, {
					html,
					filePath,
					epoch: renderEpoch
				})
			}
			res.statusCode = status
			res.setHeader('Content-Type', 'text/html')
			res.end(html)
		} catch (err) {
			console.error(err)
			res.statusCode = 500
			res.end('Internal Server Error')
		}
	}

	if (Array.isArray(server.middlewares.stack)) {
		server.middlewares.stack.unshift({ route: '', handle: htmlMiddleware })
	} else {
		server.middlewares.use(htmlMiddleware)
	}

	await server.listen()
	server.printUrls()

	const _invalidate = (id) => {
		const _module = server.moduleGraph.getModuleById(id)
		if (_module) {
			server.moduleGraph.invalidateModule(_module)
		}
	}
	const invalidateRewindInject = () => {
		_invalidate('\0/.methanol_virtual_module/registry.js')
		_invalidate('\0methanol:registry')
		_invalidate('\0/.methanol_virtual_module/inject.js')
		_invalidate('\0methanol:inject')
	}

	let queue = Promise.resolve()
	const enqueue = (task) => {
		queue = queue.then(task).catch((err) => {
			console.error(err)
		})
		return queue
	}

	const reload = () => {
		server.ws.send({ type: 'full-reload' })
	}

	runInitialCompile()

	const refreshPages = async () => {
		await refreshPagesContext()
		invalidateHtmlCache()
		reload()
	}

	const getExportName = (filePath) => basename(filePath).split('.')[0]

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

	const updateComponentEntry = async (filePath, { fallback = false } = {}) => {
		bumpComponentImportNonce()
		const exportName = getExportName(filePath)
		const dir = dirname(filePath)
		let ext = extname(filePath)
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

	const schedulePageUpdate = (filePath, kind) => {
		const existing = pageUpdateTimers.get(filePath)
		if (existing?.timer) {
			clearTimeout(existing.timer)
		}
		const entry = {
			kind,
			timer: setTimeout(() => {
				pageUpdateTimers.delete(filePath)
				enqueue(() => handlePageUpdate(filePath, kind))
			}, PAGE_UPDATE_DEBOUNCE_MS)
		}
		pageUpdateTimers.set(filePath, entry)
	}

	const resolveWatchedSource = (filePath) => {
		const inUserPages = routePathFromFile(filePath, state.PAGES_DIR)
		if (inUserPages) {
			return { pagesDir: state.PAGES_DIR, source: 'user', routePath: inUserPages }
		}
		if (state.THEME_PAGES_DIR) {
			const inThemePages = routePathFromFile(filePath, state.THEME_PAGES_DIR)
			if (inThemePages) {
				return { pagesDir: state.THEME_PAGES_DIR, source: 'theme', routePath: inThemePages }
			}
		}
		return null
	}

	const updatePageEntry = async (filePath, resolved) => {
		if (!pagesContext || !resolved) return false
		pagesContext.clearDerivedTitle?.(filePath)
		const nextEntry = await buildPageEntry({
			filePath,
			pagesDir: resolved.pagesDir,
			source: resolved.source
		})
		if (!nextEntry) return false
		const prevEntry = pagesContext.pages?.find?.((page) => page.filePath === filePath) || null
		if (!prevEntry) return false
		if (prevEntry.exclude !== nextEntry.exclude) return false
		if (prevEntry.isIndex !== nextEntry.isIndex || prevEntry.dir !== nextEntry.dir) return false
		Object.assign(prevEntry, nextEntry)
		prevEntry.mdxComponent = null
		prevEntry.toc = null
		pagesContext.refreshPagesTree?.()
		pagesContext.refreshLanguages?.()
		if (prevEntry.content && prevEntry.content.trim().length) {
			await compilePageMdx(prevEntry, pagesContext, {
				lazyPagesTree: true,
				refreshPagesTree: false
			})
			// Avoid caching a potentially stale render; recompile on request.
			prevEntry.mdxComponent = null
		}
		return true
	}

	const isUserHeadAsset = (filePath) => {
		const name = basename(filePath)
		if (name !== 'style.css' && name !== 'index.js' && name !== 'index.ts') {
			return false
		}
		const root = resolve(state.PAGES_DIR || '')
		return root && resolve(dirname(filePath)) === root
	}

	const handlePageUpdate = async (filePath, kind) => {
		if (isUserHeadAsset(filePath)) {
			invalidateHtmlCache()
			reload()
			return
		}
		const resolved = resolveWatchedSource(filePath)
		if (kind === 'unlink') {
			if (resolved?.routePath) {
				htmlCache.delete(resolved.routePath)
			} else {
				return
			}
			await refreshPages()
			return
		}
		const updated = await updatePageEntry(filePath, resolved)
		if (updated) {
			invalidateHtmlCache()
			reload()
			return
		}
		if (!resolved?.routePath) {
			return
		}
		await refreshPages()
	}

	pageWatcher.on('change', (filePath) => {
		schedulePageUpdate(filePath, 'change')
	})

	pageWatcher.on('add', (filePath) => {
		schedulePageUpdate(filePath, 'add')
	})
	pageWatcher.on('unlink', (filePath) => {
		schedulePageUpdate(filePath, 'unlink')
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

	componentWatcher.on('add', (filePath) => {
		if (!isComponentFile(filePath)) {
			return
		}
		if (isClientComponent(filePath)) {
			enqueue(async () => {
				const { hasClient } = await updateComponentEntry(filePath)
				if (hasClient) {
					invalidateRewindInject()
				}
				invalidateHtmlCache()
				reload()
			})
			return
		}
		enqueue(async () => {
			const { hasClient } = await updateComponentEntry(filePath)
			invalidateHtmlCache()
			if (hasClient) {
				invalidateRewindInject()
			}
			reload()
		})
	})

	componentWatcher.on('change', (filePath) => {
		if (!isComponentFile(filePath)) {
			return
		}
		if (isClientComponent(filePath)) {
			enqueue(async () => {
				await updateComponentEntry(filePath)
				invalidateHtmlCache()
			})
			return
		}
		enqueue(async () => {
			const { hasClient } = await updateComponentEntry(filePath)
			invalidateHtmlCache()
			if (hasClient) {
				invalidateRewindInject()
			}
			reload()
		})
	})

	componentWatcher.on('unlink', (filePath) => {
		if (!isComponentFile(filePath)) return
		if (isClientComponent(filePath)) {
			enqueue(async () => {
				await updateComponentEntry(filePath, { fallback: true })
				invalidateRewindInject()
				invalidateHtmlCache()
				reload()
			})
			return
		}
		const exportName = getExportName(filePath)
		const currentSource = componentSources.get(exportName)
		if (currentSource && currentSource !== filePath && existsSync(currentSource)) {
			return
		}
		enqueue(async () => {
			const { hasClient } = await updateComponentEntry(filePath, {
				fallback: true
			})
			invalidateHtmlCache()
			if (hasClient) {
				invalidateRewindInject()
			}
			reload()
		})
	})
}
