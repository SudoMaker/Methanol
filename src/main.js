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

import { loadUserConfig, applyConfig } from './config.js'
import { runViteDev } from './dev-server.js'
import { buildHtmlEntries, runViteBuild } from './build-system.js'
import { runPagefind } from './pagefind.js'
import { generateRssFeed } from './feed.js'
import { runVitePreview } from './preview-server.js'
import { cli, state } from './state.js'
import { HTMLRenderer } from './renderer.js'
import { readFile } from 'fs/promises'
import { style, logger } from './logger.js'

const printBanner = async () => {
	try {
		const pkgUrl = new URL('../package.json', import.meta.url)
		const raw = await readFile(pkgUrl, 'utf-8')
		const pkg = JSON.parse(raw)
		const version = `v${pkg.version}`
		const isTty = Boolean(process.stdout && process.stdout.isTTY)
		const label = `Methanol ${version}`.trim()
		if (isTty) {
			const bannerUrl = new URL('../banner.txt', import.meta.url)
			const banner = await readFile(bannerUrl, 'utf-8')
			console.log(banner.trimEnd())
			console.log(`\n\t${label}\n`)
		} else {
			console.log(label)
		}
	} catch {
		console.log('Methanol')
	}
}

const main = async () => {
	await printBanner()
	const command = cli.command
	if (!command) {
		cli.showHelp()
		process.exit(1)
	}
	const normalizedCommand = command === 'preview' ? 'serve' : command
	const isDev = normalizedCommand === 'dev'
	const isPreview = normalizedCommand === 'serve'
	const isBuild = normalizedCommand === 'build'
	const mode = isDev ? 'development' : 'production'
	const config = await loadUserConfig(mode, cli.CLI_CONFIG_PATH)
	await applyConfig(config, mode)
	const userSite = state.USER_SITE || {}
	const siteBase = state.VITE_BASE ?? userSite.base ?? null
	const hookContext = {
		mode,
		root: state.ROOT_DIR,
		command: normalizedCommand,
		isDev,
		isBuild,
		isPreview,
		HTMLRenderer,
		site: {
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
			}
		},
		data: {}
	}
	const runHooks = async (hooks = [], extra = null) => {
		const context = extra ? { ...hookContext, ...extra } : hookContext
		for (const hook of hooks) {
			await hook(context)
		}
	}
	if (isDev) {
		await runHooks(state.USER_PRE_BUILD_HOOKS)
		await runHooks(state.THEME_PRE_BUILD_HOOKS)
		await runViteDev()
		return
	}
	if (isPreview) {
		await runVitePreview()
		return
	}
	if (isBuild) {
		const startTime = performance.now()
		await runHooks(state.USER_PRE_BUILD_HOOKS)
		await runHooks(state.THEME_PRE_BUILD_HOOKS)
		const { entry, htmlCache, pagesContext, rssContent } = await buildHtmlEntries()
		const buildContext = pagesContext
			? {
					pagesContext,
					pages: pagesContext.pages,
					pagesTree: pagesContext.pagesTree,
					pagesByRoute: pagesContext.pagesByRoute,
					site: pagesContext.site
				}
			: null
		await runHooks(state.USER_PRE_BUNDLE_HOOKS, buildContext)
		await runHooks(state.THEME_PRE_BUNDLE_HOOKS, buildContext)
		await runViteBuild(entry, htmlCache)
		await runHooks(state.THEME_POST_BUNDLE_HOOKS, buildContext)
		await runHooks(state.USER_POST_BUNDLE_HOOKS, buildContext)
		if (state.PAGEFIND_ENABLED) {
			await runPagefind()
		}
		if (state.RSS_ENABLED) {
			await generateRssFeed(pagesContext, rssContent)
		}
		await runHooks(state.THEME_POST_BUILD_HOOKS, buildContext)
		await runHooks(state.USER_POST_BUILD_HOOKS, buildContext)
		const endTime = performance.now()
		const duration = endTime - startTime
		const timeString = duration > 1000 ? `${(duration / 1000).toFixed(2)}s` : `${Math.round(duration)}ms`
		const totalPages = pagesContext?.pages?.length ?? 0
		const pageLabel = totalPages === 1 ? 'page' : 'pages'
		console.log()
		logger.success(
			`Build complete! Processed ${style.bold(totalPages)} ${pageLabel} in ${style.bold(timeString)}.`
		)
		return
	}
	cli.showHelp()
	process.exit(1)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
