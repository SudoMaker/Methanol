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
import { build as viteBuild, mergeConfig, normalizePath } from 'vite'
import { state, cli } from './state.js'
import { resolveUserViteConfig } from './config.js'
import { buildPagesContext } from './pages.js'
import { renderHtml } from './mdx.js'
import { buildComponentRegistry } from './components.js'
import { methanolVirtualHtmlPlugin, methanolResolverPlugin } from './vite-plugins.js'
import { createStageLogger } from './stage-logger.js'
import { copyPublicDir } from './public-assets.js'

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

export const buildHtmlEntries = async () => {
	if (state.INTERMEDIATE_DIR) {
		await rm(state.INTERMEDIATE_DIR, { recursive: true, force: true })
		await ensureDir(state.INTERMEDIATE_DIR)
	}

	const logEnabled = state.CURRENT_MODE === 'production' && cli.command === 'build'
	const stageLogger = createStageLogger(logEnabled)
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
	const { components } = await buildComponentRegistry()
	const mergedComponents = {
		...themeComponents,
		...components
	}
	const pagesContext = await buildPagesContext()
	const entry = {}
	const htmlCache = new Map()
	const resolveOutputName = (page) => {
		if (page.routePath === '/') return 'index'
		if (page.isIndex && page.dir) {
			return normalizePath(join(page.dir, 'index'))
		}
		return page.routePath.slice(1)
	}

	const renderToken = stageLogger.start('Rendering pages')
	const totalPages = pagesContext.pages.length
	for (let i = 0; i < pagesContext.pages.length; i++) {
		const page = pagesContext.pages[i]
		if (logEnabled) {
			stageLogger.update(
				renderToken,
				`Rendering pages [${i + 1}/${totalPages}] ${page.filePath}`
			)
		}
		const html = await renderHtml({
			routePath: page.routePath,
			filePath: page.filePath,
			components: mergedComponents,
			pagesContext,
			pageMeta: page
		})
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
	stageLogger.end(renderToken)

	const htmlFiles = await collectHtmlFiles(state.PAGES_DIR)
	const excludedDirs = pagesContext.excludedDirs || new Set()
	const isHtmlExcluded = (relativePath) => {
		if (!excludedDirs.size) return false
		const dir = relativePath.split('/').slice(0, -1).join('/')
		if (!dir) return false
		for (const excludedDir of excludedDirs) {
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
	if (state.STATIC_DIR !== false) {
		await copyPublicDir({
			sourceDir: state.THEME_PUBLIC_DIR,
			targetDir: state.STATIC_DIR,
			label: 'theme public'
		})
	}
	const copyPublicDirEnabled = state.STATIC_DIR !== false
	const baseConfig = {
		configFile: false,
		root: state.PAGES_DIR,
		base: '/',
		publicDir: state.STATIC_DIR === false ? false : state.STATIC_DIR,
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
		plugins: [methanolVirtualHtmlPlugin(htmlCache), methanolResolverPlugin()]
	}
	const userConfig = await resolveUserViteConfig('build')
	const finalConfig = userConfig ? mergeConfig(baseConfig, userConfig) : baseConfig
	await viteBuild(finalConfig)
}
