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
import { createStarryNight } from '@wooorm/starry-night'
import remarkGfm from 'remark-gfm'
import { HTMLRenderer } from './renderer.js'
import { Suspense, nextTick } from 'refui'
import { createPortal } from 'refui/extras'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'
import { resolve, dirname, basename, relative } from 'path'
import { state } from './state.js'
import { resolveUserMdxConfig, withBase } from './config.js'
import { methanolCtx } from './rehype-plugins/methanol-ctx.js'
import { linkResolve } from './rehype-plugins/link-resolve.js'
import { cached } from './utils.js'
import { resetReframeRenderCount, setReframeHydrationEnabled, getReframeHydrationEnabled } from './components.js'

// Workaround for Vite: it doesn't support resolving module/virtual modules in script src in dev mode
const resolveRewindInject = cached(() =>
	HTMLRenderer.rawHTML(`<script type="module" src="${withBase('/.methanol_virtual_module/inject.js')}"></script>`)
)
const RWND_FALLBACK = HTMLRenderer.rawHTML(
	'<script>if(!window.$$rfrm){var l=[];var r=function(k,i,p){l.push([k,i,p,document.currentScript])};r.$$loaded=l;window.$$rfrm=r}</script>'
)

let cachedHeadAssets = null
let cachedSiteHeadAssets = null

const resolveUserHeadAssets = () => {
	if (cachedHeadAssets) {
		return cachedHeadAssets
	}
	const assets = []
	const pagesDir = state.PAGES_DIR
	if (!pagesDir) return assets
	if (existsSync(resolve(pagesDir, 'style.css'))) {
		assets.push(HTMLRenderer.c('link', { rel: 'stylesheet', href: withBase('/style.css') }))
	}
	if (existsSync(resolve(pagesDir, 'index.js'))) {
		assets.push(HTMLRenderer.c('script', { type: 'module', src: withBase('/index.js') }))
	} else if (existsSync(resolve(pagesDir, 'index.ts'))) {
		assets.push(HTMLRenderer.c('script', { type: 'module', src: withBase('/index.ts') }))
	}
	if (state.CURRENT_MODE === 'production') {
		cachedHeadAssets = assets
	}
	return assets
}

const resolvePageAssetUrl = (page, path) => {
	const root = page.source === 'theme' && state.THEME_PAGES_DIR ? state.THEME_PAGES_DIR : state.PAGES_DIR
	if (!root) return null
	const relPath = relative(root, path).replace(/\\/g, '/')
	if (!relPath || relPath.startsWith('..')) return null
	return withBase(`/${relPath}`)
}

const resolvePageHeadAssets = (page) => {
	if (!page.path) return []
	const baseDir = dirname(page.path)
	const baseName = basename(page.path).replace(/\.(mdx|md)$/, '')
	const pagesRoot = state.PAGES_DIR ? resolve(state.PAGES_DIR) : null
	const isRootIndex = pagesRoot && baseName === 'index' && resolve(baseDir) === pagesRoot && page.source !== 'theme'
	const isRootStylePage = pagesRoot && baseName === 'style' && resolve(baseDir) === pagesRoot && page.source !== 'theme'
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

const resolveSiteHeadAssets = (ctx) => {
	if (cachedSiteHeadAssets) {
		return cachedSiteHeadAssets
	}
	const assets = []
	const site = ctx?.site || {}
	const feed = site.feed
	if (feed?.enabled && feed.href) {
		const label = feed.atom ? 'Atom' : 'RSS'
		const name = typeof site.name === 'string' && site.name.trim() ? site.name : 'Site'
		const type = feed.atom ? 'application/atom+xml' : 'application/rss+xml'
		assets.push(
			HTMLRenderer.c('link', {
				rel: 'alternate',
				type,
				title: `${name} ${label}`,
				href: feed.href
			})
		)
	}
	const pwa = site.pwa
	if (pwa?.enabled && pwa.manifestHref) {
		assets.push(HTMLRenderer.c('link', { rel: 'manifest', href: pwa.manifestHref }))
	}
	if (state.CURRENT_MODE === 'production') {
		cachedSiteHeadAssets = assets
	}
	return assets
}

export const buildPageContext = ({ routePath, path, pageMeta, pagesContext, lazyPagesTree = false }) => {
	const page = pageMeta
	const language = pagesContext.getLanguageForRoute ? pagesContext.getLanguageForRoute(routePath) : null
	const getSiblings = pagesContext.getSiblings ? () => pagesContext.getSiblings(routePath, page.path || path) : null
	if (page && getSiblings && page.getSiblings !== getSiblings) {
		page.getSiblings = getSiblings
	}
	const ctx = {
		routePath,
		routeHref: withBase(routePath),
		path,
		page,
		pages: pagesContext.pages || [],
		pagesByRoute: pagesContext.pagesByRoute || new Map(),
		languages: pagesContext.languages || [],
		language,
		site: pagesContext.site || null,
		getSiblings,
		withBase
	}
	if (!lazyPagesTree) {
		ctx.pagesTree = pagesContext.getPagesTree ? pagesContext.getPagesTree(routePath) : pagesContext.pagesTree || []
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
	if (enabled === false) return { enabled: false, options }
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
		options: state.STARRY_NIGHT_OPTIONS || null,
		explicit: false
	}
	if (!frontmatter || !Object.prototype.hasOwnProperty.call(frontmatter, 'starryNight')) {
		return base
	}
	const overrideValue = frontmatter.starryNight
	if (typeof overrideValue === 'boolean') {
		if (overrideValue === false) {
			return { enabled: false, options: null, explicit: true }
		}
		return { enabled: true, options: base.options, explicit: false }
	}
	if (!overrideValue || typeof overrideValue !== 'object') {
		return base
	}
	const override = normalizeStarryNightConfig(overrideValue)
	if (!override) return base
	if (override.enabled === false) return { enabled: false, options: null, explicit: true }
	const options = override.options != null ? override.options : base.options
	return { enabled: true, options, explicit: true }
}

const CODE_FENCE_LANG_PATTERN = /(^|\n)\s*(```|~~~)\s*([^\s{]+)/g
const extractCodeFenceLanguages = (value) => {
	const text = String(value || '')
	const languages = new Set()
	CODE_FENCE_LANG_PATTERN.lastIndex = 0
	let match
	while ((match = CODE_FENCE_LANG_PATTERN.exec(text))) {
		let lang = match[3] ? String(match[3]).trim() : ''
		if (!lang) continue
		const braceIndex = lang.indexOf('{')
		if (braceIndex >= 0) {
			lang = lang.slice(0, braceIndex).trim()
		}
		if (!lang || !/[A-Za-z]/.test(lang)) continue
		languages.add(lang.toLowerCase())
	}
	return languages
}
const cleanStarryOptions = (options) => {
	if (!options || typeof options !== 'object') return undefined
	const next = { ...options }
	delete next.grammars
	return next
}
let starryNightFuture = null
const resolvedGrammarCache = new Map()
const resolvedCustomGrammarCache = new Map()
const failedLanguageCache = new Set()
const failedCustomLanguageCache = new Map()
const loadStarryNight = async (options) => {
	if (!starryNightFuture) {
		starryNightFuture = import('@wooorm/starry-night').then(async (mod) => {
			const grammars = Array.isArray(mod?.all) ? mod.all : []
			const starryNight = await createStarryNight(grammars, cleanStarryOptions(options))
			return {
				starryNight,
				grammars,
				scopeMap: buildScopeGrammarMap(grammars)
			}
		})
	}
	return starryNightFuture
}
const buildScopeGrammarMap = (grammars) => {
	const scopeMap = new Map()
	for (const grammar of grammars || []) {
		const scopeName = grammar?.scopeName
		if (typeof scopeName === 'string' && scopeName) {
			scopeMap.set(scopeName, grammar)
		}
	}
	return scopeMap
}
const collectExternalScopes = (grammar) => {
	const scopes = new Set()
	const addScope = (value) => {
		if (typeof value !== 'string') return
		if (!value || value.startsWith('#')) return
		scopes.add(value)
	}
	const visit = (node) => {
		if (!node) return
		if (Array.isArray(node)) {
			for (const item of node) {
				visit(item)
			}
			return
		}
		if (typeof node !== 'object') return
		if (typeof node.include === 'string') {
			addScope(node.include)
		}
		for (const value of Object.values(node)) {
			visit(value)
		}
	}
	if (Array.isArray(grammar?.dependencies)) {
		for (const dep of grammar.dependencies) {
			addScope(dep)
		}
	}
	visit(grammar?.patterns)
	visit(grammar?.repository)
	return scopes
}
const resolveStarryNightGrammars = async (languages, options) => {
	const hasCustomGrammars = Array.isArray(options?.grammars)
	const baseGrammars = hasCustomGrammars ? options.grammars : null
	if (hasCustomGrammars && (!baseGrammars || !baseGrammars.length)) return null
	const getCustomKey = (grammars) =>
		(grammars || [])
			.map((grammar) => grammar?.scopeName)
			.filter(Boolean)
			.sort()
			.join('|')
	const failedSet = hasCustomGrammars
		? (() => {
				const customKey = getCustomKey(baseGrammars)
				let set = failedCustomLanguageCache.get(customKey)
				if (!set) {
					set = new Set()
					failedCustomLanguageCache.set(customKey, set)
				}
				return set
			})()
		: failedLanguageCache
	const filteredLanguages = Array.from(languages || [])
		.map((lang) => String(lang).toLowerCase())
		.filter((lang) => lang && !failedSet.has(lang))
	const languageKey = filteredLanguages.slice().sort().join('|')
	if (!languageKey) return []
	if (hasCustomGrammars) {
		const customKey = getCustomKey(baseGrammars)
		const customCache = resolvedCustomGrammarCache.get(customKey)
		if (customCache?.has(languageKey)) {
			return customCache.get(languageKey)
		}
	} else if (resolvedGrammarCache.has(languageKey)) {
		return resolvedGrammarCache.get(languageKey)
	}
	const selected = new Set()
	const selectedScopes = new Set()
	let scopeMap = baseGrammars ? buildScopeGrammarMap(baseGrammars) : null
	let loadedStarryNight = null
	const ensureAll = async () => {
		if (!loadedStarryNight && !hasCustomGrammars) {
			loadedStarryNight = await loadStarryNight(options)
			if (!scopeMap) {
				scopeMap = loadedStarryNight?.scopeMap || null
			}
		}
	}
	let flagToScope = null
	if (hasCustomGrammars) {
		const customStarryNight = await createStarryNight(baseGrammars, cleanStarryOptions(options))
		flagToScope = (lang) => customStarryNight.flagToScope(String(lang))
	} else {
		try {
			await ensureAll()
		} catch {
			for (const lang of filteredLanguages) {
				failedSet.add(lang)
			}
			return []
		}
		flagToScope = (lang) => loadedStarryNight?.starryNight.flagToScope(String(lang))
	}
	if (!scopeMap) return null
	const addGrammar = (grammar) => {
		if (!grammar) return false
		const scopeName = grammar.scopeName
		if (!scopeName || selectedScopes.has(scopeName)) return false
		selectedScopes.add(scopeName)
		selected.add(grammar)
		return true
	}
	for (const lang of filteredLanguages) {
		let scope
		try {
			scope = flagToScope ? flagToScope(String(lang)) : undefined
		} catch {
			scope = undefined
		}
		const grammar = scope && scopeMap ? scopeMap.get(scope) : null
		if (!grammar) {
			failedSet.add(lang)
		}
		addGrammar(grammar)
	}
	if (!selected.size) return []
	const queue = Array.from(selected)
	while (queue.length) {
		const grammar = queue.pop()
		const scopes = collectExternalScopes(grammar)
		for (const scope of scopes) {
			if (selectedScopes.has(scope)) continue
			let depGrammar = scopeMap ? scopeMap.get(scope) : null
			if (!depGrammar && !hasCustomGrammars) {
				await ensureAll()
				depGrammar = scopeMap ? scopeMap.get(scope) : null
			}
			if (addGrammar(depGrammar)) {
				queue.push(depGrammar)
			}
		}
	}
	const result = selected.size ? Array.from(selected) : []
	if (hasCustomGrammars) {
		const customKey = getCustomKey(baseGrammars)
		let customCache = resolvedCustomGrammarCache.get(customKey)
		if (!customCache) {
			customCache = new Map()
			resolvedCustomGrammarCache.set(customKey, customCache)
		}
		customCache.set(languageKey, result)
	} else {
		resolvedGrammarCache.set(languageKey, result)
	}
	return result
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
		rehypePlugins: [rehypeSlug, extractToc, [withTocExport, { name: 'toc' }]],
		remarkPlugins: []
	}

	if (state.GFM_ENABLED) {
		baseMdxConfig.remarkPlugins.push(remarkGfm)
	}

	const mdxConfig = { ...baseMdxConfig, ...userMdxConfig }
	const userRehypePlugins = Array.isArray(userMdxConfig.rehypePlugins) ? userMdxConfig.rehypePlugins : []
	mdxConfig.rehypePlugins = [...baseMdxConfig.rehypePlugins, ...userRehypePlugins]

	const userRemarkPlugins = Array.isArray(userMdxConfig.remarkPlugins) ? userMdxConfig.remarkPlugins : []
	mdxConfig.remarkPlugins = [...baseMdxConfig.remarkPlugins, ...userRemarkPlugins]

	mdxConfig.rehypePlugins.push(linkResolve)
	mdxConfig.rehypePlugins.push(methanolCtx)
	return (cachedMdxConfig = mdxConfig)
}

const resolveMdxConfigForPage = async (frontmatter, content = '') => {
	const baseConfig = await resolveBaseMdxConfig()
	const mdxConfig = {
		...baseConfig,
		rehypePlugins: [...baseConfig.rehypePlugins]
	}
	const starryNightConfig = resolveStarryNightForPage(frontmatter)
	if (!starryNightConfig.enabled) return mdxConfig
	let options = starryNightConfig.options
	if (!starryNightConfig.explicit) {
		const languages = extractCodeFenceLanguages(content)
		if (!languages.size) {
			return mdxConfig
		}
		const grammars = await resolveStarryNightGrammars(languages, options)
		if (!grammars || !grammars.length) {
			return mdxConfig
		}
		options = { ...(options || {}), grammars }
	}
	const plugin = options ? [rehypeStarryNight, options] : [rehypeStarryNight]
	const insertIndex = mdxConfig.rehypePlugins.indexOf(linkResolve)
	if (insertIndex >= 0) {
		mdxConfig.rehypePlugins.splice(insertIndex, 0, plugin)
	} else {
		mdxConfig.rehypePlugins.push(plugin)
	}
	return mdxConfig
}

export const compileMdxSource = async ({ content, path, frontmatter }) => {
	const mdxConfig = await resolveMdxConfigForPage(frontmatter, content)
	const compiled = await compile({ value: content, path: path }, mdxConfig)
	const code = String(compiled.value ?? compiled)
	return { code, development: Boolean(mdxConfig.development) }
}

export const runMdxSource = async ({ code, path, ctx, development = null }) => {
	const isDev = development == null ? state.CURRENT_MODE !== 'production' : development
	const runtimeFactory = isDev ? JSXDevFactory : JSXFactory
	return await run(code, {
		...runtimeFactory,
		baseUrl: pathToFileURL(path).href,
		ctx,
		rawHTML: HTMLRenderer.rawHTML
	})
}

export const compileMdx = async ({ content, path, ctx }) => {
	const result = await compileMdxSource({
		content,
		path,
		frontmatter: ctx?.page?.frontmatter || null
	})
	return await runMdxSource({
		code: result.code,
		path,
		ctx,
		development: result.development
	})
}

export const compilePageMdx = async (page, pagesContext, options = {}) => {
	if (!page || page.content == null || page.mdxComponent) return
	const { ctx = null, lazyPagesTree = false, refreshPagesTree = true, compiled = null } = options || {}
	const activeCtx =
		ctx ||
		buildPageContext({
			routePath: page.routePath,
			path: page.path,
			pageMeta: page,
			pagesContext,
			lazyPagesTree
		})
	page.mdxCtx = activeCtx
	const mdxModule = compiled?.code
		? await runMdxSource({
				code: compiled.code,
				path: page.path,
				ctx: activeCtx,
				development: compiled.development
			})
		: await compileMdx({
				content: page.content,
				path: page.path,
				ctx: activeCtx
			})
	page.mdxComponent = mdxModule.default
	page.toc = mdxModule.toc
	const shouldUseTocTitle = page.frontmatter?.title == null
	if (shouldUseTocTitle) {
		const nextTitle = findTitleFromToc(page.toc) || page.title
		if (nextTitle !== page.title) {
			page.title = nextTitle
			if (typeof pagesContext.refreshPagesTree === 'function') {
				pagesContext.refreshPagesTree()
			}
		}
	}
	if (typeof pagesContext.setDerivedTitle === 'function') {
		pagesContext.setDerivedTitle(page.path, shouldUseTocTitle ? page.title : null, page.toc)
	}
	if (ctx && refreshPagesTree && pagesContext.getPagesTree) {
		ctx.pagesTree = pagesContext.getPagesTree(activeCtx.routePath)
	}
}

export const renderHtml = async ({ routePath, path, components, pagesContext, pageMeta }) => {
	resetReframeRenderCount()
	const ctx = buildPageContext({
		routePath,
		path,
		pageMeta,
		pagesContext
	})

	await compilePageMdx(pageMeta, pagesContext, { ctx })

	const [Head, Outlet] = createPortal()
	const ExtraHead = () => {
		return [
			resolveRewindInject(),
			...resolveUserHeadAssets(),
			...resolvePageHeadAssets(pageMeta),
			...resolveSiteHeadAssets(ctx),
			Outlet(),
			RWND_FALLBACK
		]
	}

	const PageContent = ({ components: extraComponents, ...props }, ...children) =>
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
	const mdxComponent = pageMeta.mdxComponent

	const renderResult = await new Promise((resolve, reject) => {
		const result = HTMLRenderer.c(
			Suspense,
			{
				onLoad() {
					nextTick(() => resolve(result))
				},
				catch({ error }) {
					reject(error)
				}
			},
			template({
				ctx,
				page: ctx.page,
				withBase,
				PageContent,
				ExtraHead,
				HTMLRenderer,
				components
			})
		)
	})

	const result = HTMLRenderer.serialize(renderResult)

	return result
}

export const renderPageContent = async ({ routePath, path, components, pagesContext, pageMeta }) => {
	const ctx = buildPageContext({
		routePath,
		path,
		pageMeta,
		pagesContext,
		lazyPagesTree: true
	})

	await compilePageMdx(pageMeta, pagesContext, { ctx })

	const prevHydration = getReframeHydrationEnabled()
	const prevThemeHydration = state.THEME_ENV?.getHydrationEnabled?.()
	setReframeHydrationEnabled(false)
	state.THEME_ENV?.setHydrationEnabled?.(false)
	const mdxComponent = pageMeta.mdxComponent
	const PageContent = () => mdxComponent({ components })

	try {
		const renderResult = await new Promise((resolve, reject) => {
			const result = HTMLRenderer.c(
				Suspense,
				{
					onLoad() {
						nextTick(() => resolve(result))
					},
					catch({ error }) {
						reject(error)
					}
				},
				PageContent
			)
		})
		return HTMLRenderer.serialize(renderResult)
	} finally {
		setReframeHydrationEnabled(prevHydration)
		if (prevThemeHydration != null) {
			state.THEME_ENV?.setHydrationEnabled?.(prevThemeHydration)
		}
	}
}
