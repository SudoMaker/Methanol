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

import { compile, run } from '@mdx-js/mdx'
import * as JSXFactory from 'refui/jsx-runtime'
import * as JSXDevFactory from 'refui/jsx-dev-runtime'
import rehypeSlug from 'rehype-slug'
import extractToc from '@stefanprobst/rehype-extract-toc'
import withTocExport from '@stefanprobst/rehype-extract-toc/mdx'
import rehypeStarryNight from 'rehype-starry-night'
import { HTMLRenderer } from './renderer.js'
import { signal, computed, read, Suspense, nextTick } from 'refui'
import { createPortal } from 'refui/extras'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'
import { resolve, dirname, basename, relative } from 'path'
import { state } from './state.js'
import { resolveUserMdxConfig } from './config.js'
import { methanolCtx } from './rehype-plugins/methanol-ctx.js'
import { linkResolve } from './rehype-plugins/link-resolve.js'

// Workaround for Vite: it doesn't support resolving module/virtual modules in script src in dev mode
const RWND_INJECT = HTMLRenderer.rawHTML`<script type="module" src="/.methanol_virtual_module/inject.js"></script>`
const RWND_FALLBACK = HTMLRenderer.rawHTML`<script>
	if (!window.$$rwnd) {
		const l = []
		const r = function(k,i,p) {
			l.push([k,i,p,document.currentScript])
		}
		r.$$loaded = l
		window.$$rwnd = r
	}
</script>`

let cachedHeadAssets = null

const resolveUserHeadAssets = () => {
	if (cachedHeadAssets) {
		return cachedHeadAssets
	}
	const assets = []
	const pagesDir = state.PAGES_DIR
	if (!pagesDir) return assets
	if (existsSync(resolve(pagesDir, 'style.css'))) {
		assets.push(HTMLRenderer.c('link', { rel: 'stylesheet', href: '/style.css' }))
	}
	if (existsSync(resolve(pagesDir, 'index.js'))) {
		assets.push(HTMLRenderer.c('script', { type: 'module', src: '/index.js' }))
	} else if (existsSync(resolve(pagesDir, 'index.ts'))) {
		assets.push(HTMLRenderer.c('script', { type: 'module', src: '/index.ts' }))
	}
	if (state.CURRENT_MODE === 'production') {
		cachedHeadAssets = assets
	}
	return assets
}

const resolvePageAssetUrl = (page, filePath) => {
	const root = page?.source === 'theme' && state.THEME_PAGES_DIR
		? state.THEME_PAGES_DIR
		: state.PAGES_DIR
	if (!root) return null
	const relPath = relative(root, filePath).replace(/\\/g, '/')
	if (!relPath || relPath.startsWith('..')) return null
	return `/${relPath}`
}

const resolvePageHeadAssets = (page) => {
	if (!page?.filePath) return []
	const baseDir = dirname(page.filePath)
	const baseName = basename(page.filePath).replace(/\.(mdx|md)$/, '')
	const pagesRoot = state.PAGES_DIR ? resolve(state.PAGES_DIR) : null
	const isRootIndex =
		pagesRoot && baseName === 'index' && resolve(baseDir) === pagesRoot && page.source !== 'theme'
	const isRootStylePage =
		pagesRoot && baseName === 'style' && resolve(baseDir) === pagesRoot && page.source !== 'theme'
	const assets = []
	const cssPath = resolve(baseDir, `${baseName}.css`)
	if (existsSync(cssPath)) {
		if (isRootStylePage) {
			const rootStyle = resolve(pagesRoot, 'style.css')
			if (cssPath === rootStyle) {
				return assets
			}
		}
		const href = resolvePageAssetUrl(page, cssPath)
		if (href) {
			assets.push(HTMLRenderer.c('link', { rel: 'stylesheet', href }))
		}
	}
	const scriptExtensions = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']
	let scriptPath = null
	for (const ext of scriptExtensions) {
		const candidate = resolve(baseDir, `${baseName}${ext}`)
		if (existsSync(candidate)) {
			scriptPath = candidate
			break
		}
	}
	if (scriptPath) {
		if (isRootIndex) {
			const rootIndexJs = resolve(pagesRoot, 'index.js')
			const rootIndexTs = resolve(pagesRoot, 'index.ts')
			if (scriptPath === rootIndexJs || scriptPath === rootIndexTs) {
				return assets
			}
		}
		const src = resolvePageAssetUrl(page, scriptPath)
		if (src) {
			assets.push(HTMLRenderer.c('script', { type: 'module', src }))
		}
	}
	return assets
}

export const buildPageContext = ({
	routePath,
	filePath,
	pageMeta,
	pagesContext,
	lazyPagesTree = false
}) => {
	const page = pageMeta
	const language = pagesContext?.getLanguageForRoute ? pagesContext.getLanguageForRoute(routePath) : null
	const getSiblings = pagesContext?.getSiblings
		? () => pagesContext.getSiblings(routePath, page?.filePath || filePath)
		: null
	if (page && getSiblings && page.getSiblings !== getSiblings) {
		page.getSiblings = getSiblings
	}
	const ctx = {
		routePath,
		filePath,
		page,
		pages: pagesContext?.pages || [],
		pagesByRoute: pagesContext?.pagesByRoute || new Map(),
		languages: pagesContext?.languages || [],
		language,
		site: pagesContext?.site || null,
		getSiblings
	}
	const resolvePagesTree = () =>
		pagesContext?.getPagesTree ? pagesContext.getPagesTree(routePath) : pagesContext?.pagesTree || []
	if (lazyPagesTree) {
		let cachedTree = null
		let hasTree = false
		Object.defineProperty(ctx, 'pagesTree', {
			enumerable: true,
			get() {
				if (!hasTree) {
					cachedTree = resolvePagesTree()
					hasTree = true
				}
				return cachedTree
			},
			set(value) {
				cachedTree = value
				hasTree = true
			}
		})
	} else {
		ctx.pagesTree = resolvePagesTree()
	}
	return ctx
}

const findTitleFromToc = (toc = []) => {
	let minDepth = Infinity
	const scanDepth = (items) => {
		for (const item of items) {
			if (typeof item?.depth === 'number') {
				minDepth = Math.min(minDepth, item.depth)
			}
			if (item?.children?.length) {
				scanDepth(item.children)
			}
		}
	}
	scanDepth(toc)
	if (!Number.isFinite(minDepth)) return null
	let result = null
	const findFirst = (items) => {
		for (const item of items) {
			if (item?.depth === minDepth && item?.value) {
				result = item.value
				return true
			}
			if (item?.children?.length && findFirst(item.children)) {
				return true
			}
		}
		return false
	}
	findFirst(toc)
	return result
}

let cachedMdxConfig = null

const normalizeStarryNightConfig = (value) => {
	if (value == null) return null
	if (typeof value === 'boolean') {
		return { enabled: value, options: null }
	}
	if (typeof value !== 'object') return null
	const { enabled, options, ...rest } = value
	if (enabled === false) return { enabled: false, options: null }
	if (options && typeof options === 'object') {
		return { enabled: true, options: { ...options } }
	}
	if (Object.keys(rest).length) {
		return { enabled: true, options: { ...rest } }
	}
	return { enabled: true, options: null }
}

const resolveStarryNightForPage = (frontmatter) => {
	const base = {
		enabled: state.STARRY_NIGHT_ENABLED === true,
		options: state.STARRY_NIGHT_OPTIONS || null
	}
	if (!frontmatter || !Object.prototype.hasOwnProperty.call(frontmatter, 'starryNight')) {
		return base
	}
	const override = normalizeStarryNightConfig(frontmatter.starryNight)
	if (!override) return base
	if (override.enabled === false) return { enabled: false, options: null }
	const options = override.options != null ? override.options : base.options
	return { enabled: true, options }
}

const resolveBaseMdxConfig = async () => {
	const userMdxConfig = await resolveUserMdxConfig()
	if (cachedMdxConfig) {
		return cachedMdxConfig
	}
	const baseMdxConfig = {
		outputFormat: 'function-body',
		jsxRuntime: 'automatic',
		jsxImportSource: 'refui',
		development: state.CURRENT_MODE !== 'production',
		elementAttributeNameCase: 'html',
		rehypePlugins: [rehypeSlug, extractToc, [withTocExport, { name: 'toc' }]]
	}
	const mdxConfig = { ...baseMdxConfig, ...userMdxConfig }
	const userRehypePlugins = Array.isArray(userMdxConfig.rehypePlugins) ? userMdxConfig.rehypePlugins : []
	mdxConfig.rehypePlugins = [...baseMdxConfig.rehypePlugins, ...userRehypePlugins]
	mdxConfig.rehypePlugins.push(linkResolve)
	mdxConfig.rehypePlugins.push(methanolCtx)
	return (cachedMdxConfig = mdxConfig)
}

const resolveMdxConfigForPage = async (frontmatter) => {
	const baseConfig = await resolveBaseMdxConfig()
	const mdxConfig = {
		...baseConfig,
		rehypePlugins: [...baseConfig.rehypePlugins]
	}
	const starryNightConfig = resolveStarryNightForPage(frontmatter)
	if (!starryNightConfig.enabled) return mdxConfig
	const plugin = starryNightConfig.options ? [rehypeStarryNight, starryNightConfig.options] : [rehypeStarryNight]
	const insertIndex = mdxConfig.rehypePlugins.indexOf(linkResolve)
	if (insertIndex >= 0) {
		mdxConfig.rehypePlugins.splice(insertIndex, 0, plugin)
	} else {
		mdxConfig.rehypePlugins.push(plugin)
	}
	return mdxConfig
}

export const compileMdx = async ({ content, filePath, ctx }) => {
	const mdxConfig = await resolveMdxConfigForPage(ctx?.page?.frontmatter)
	const runtimeFactory = mdxConfig.development ? JSXDevFactory : JSXFactory
	const compiled = await compile({ value: content, path: filePath }, mdxConfig)

	return await run(compiled, {
		...runtimeFactory,
		baseUrl: pathToFileURL(filePath).href,
		ctx,
		rawHTML: HTMLRenderer.rawHTML
	})
}

export const compilePageMdx = async (page, pagesContext, options = {}) => {
	if (!page || page.content == null || page.mdxComponent) return
	const { ctx = null, lazyPagesTree = false, refreshPagesTree = true } = options || {}
	const activeCtx =
		ctx ||
		buildPageContext({
			routePath: page.routePath,
			filePath: page.filePath,
			pageMeta: page,
			pagesContext,
			lazyPagesTree
		})
	const mdxModule = await compileMdx({
		content: page.content,
		filePath: page.filePath,
		ctx: activeCtx
	})
	page.mdxComponent = mdxModule.default
	page.toc = mdxModule.toc
	const shouldUseTocTitle = page.frontmatter?.title == null
	if (shouldUseTocTitle) {
		const nextTitle = findTitleFromToc(page.toc) || page.title
		if (nextTitle !== page.title) {
			page.title = nextTitle
			if (typeof pagesContext?.refreshPagesTree === 'function') {
				pagesContext.refreshPagesTree()
			}
		}
	}
	if (typeof pagesContext?.setDerivedTitle === 'function') {
		pagesContext.setDerivedTitle(page.filePath, shouldUseTocTitle ? page.title : null, page.toc)
	}
	if (ctx && refreshPagesTree && pagesContext?.getPagesTree) {
		ctx.pagesTree = pagesContext.getPagesTree(activeCtx.routePath)
	}
}

export const renderHtml = async ({
	routePath,
	filePath,
	components,
	pagesContext,
	pageMeta: explicitPageMeta = null
}) => {
	const pageMeta =
		explicitPageMeta ||
		(pagesContext.getPageByRoute
			? pagesContext.getPageByRoute(routePath, { filePath })
			: pagesContext.pagesByRoute.get(routePath))

	const ctx = buildPageContext({
		routePath,
		filePath,
		pageMeta,
		pagesContext
	})
	await compilePageMdx(pageMeta, pagesContext, { ctx })

	const [Head, Outlet] = createPortal()
	const ExtraHead = () => {
		return [
			RWND_INJECT,
			...resolveUserHeadAssets(),
			...resolvePageHeadAssets(pageMeta),
			Outlet(),
			RWND_FALLBACK
		]
	}

	const mdxComponent = pageMeta?.mdxComponent

	const Page = ({ components: extraComponents, ...props }, ...children) =>
		mdxComponent({
			children,
			...props,
			components: {
				...components,
				...extraComponents,
				head: Head,
				Head
			}
		})

	const template = state.USER_THEME.template

	const renderResult = await new Promise((r) => {
		const result = HTMLRenderer.c(
			Suspense,
			{
				onLoad() {
					nextTick(() => r(result))
				}
			},
			() =>
				template({
					ctx,
					Page,
					ExtraHead,
					HTMLRenderer,
					components
				})
		)
	})

	return HTMLRenderer.serialize(renderResult)
}
