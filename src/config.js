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

import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve, isAbsolute, extname, basename } from 'path'
import { pathToFileURL } from 'url'
import { mergeConfig } from 'vite'
import { cli, state } from './state.js'
import { HTMLRenderer } from './renderer.js'
import { rewindEnv } from './components.js'
import { env as createEnv } from './rewind.js'
import defaultTheme from '../themes/default/index.js'

const CONFIG_FILENAMES = [
	'methanol.config.js',
	'methanol.config.mjs',
	'methanol.config.cjs',
	'methanol.config.ts',
	'methanol.config.jsx',
	'methanol.config.mts',
	'methanol.config.cts',
	'methanol.config.tsx'
]

const resolveRootPath = (value) => {
	if (!value) {
		return state.PROJECT_ROOT
	}
	return isAbsolute(value) ? value : resolve(state.PROJECT_ROOT, value)
}

const resolveFromRoot = (root, value, fallback) => {
	if (!value) {
		return resolve(root, fallback)
	}
	return isAbsolute(value) ? value : resolve(root, value)
}

const resolveOptionalPath = (root, value, fallback) => {
	if (value === false) {
		return false
	}
	return resolveFromRoot(root, value, fallback)
}

const resolveThemeComponentDir = (root, value) => {
	if (value == null) return null
	if (value === false) return false
	return isAbsolute(value) ? value : resolve(root, value)
}

const resolveThemePagesDir = (root, value) => {
	if (value == null) return null
	if (value === false) return false
	return isAbsolute(value) ? value : resolve(root, value)
}

const resolveThemePublicDir = (root, value) => {
	if (value == null) return null
	if (value === false) return false
	return isAbsolute(value) ? value : resolve(root, value)
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key)
const normalizeSources = (value, root) => {
	if (!value) return []
	const entries = []
	const addEntry = (find, replacement) => {
		if (!find || !replacement) return
		let resolvedReplacement = replacement
		if (typeof replacement === 'string' && !isAbsolute(replacement)) {
			resolvedReplacement = resolve(root, replacement)
		}
		entries.push({ find, replacement: resolvedReplacement })
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			if (!entry) continue
			if (typeof entry === 'object') {
				addEntry(entry.find, entry.replacement)
			}
		}
		return entries
	}
	if (typeof value === 'object') {
		for (const [find, replacement] of Object.entries(value)) {
			addEntry(find, replacement)
		}
	}
	return entries
}

const resolvePagefindEnabled = (config) => {
	if (config?.pagefind == null) return false
	if (typeof config.pagefind === 'boolean') return config.pagefind
	if (typeof config.pagefind === 'object') {
		if (hasOwn(config.pagefind, 'enabled')) {
			return config.pagefind.enabled !== false
		}
	}
	return true
}

const resolvePagefindOptions = (config) => {
	const value = config?.pagefind
	if (!value || typeof value !== 'object') return null
	const { enabled, options, build, buildOptions, ...rest } = value
	if (options && typeof options === 'object') {
		return { ...options }
	}
	if (Object.keys(rest).length) {
		return { ...rest }
	}
	return null
}

const resolvePagefindBuild = (config) => {
	const value = config?.pagefind
	if (!value || typeof value !== 'object') return null
	const build = value.build
	if (build && typeof build === 'object') {
		return { ...build }
	}
	return null
}

const resolveStarryNightConfig = (value) => {
	if (value == null) return { enabled: false, options: null }
	if (typeof value === 'boolean') {
		return { enabled: value, options: null }
	}
	if (typeof value !== 'object') {
		return { enabled: false, options: null }
	}
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

const normalizeHooks = (value) => {
	if (!value) return []
	if (typeof value === 'function') return [value]
	if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'function')
	return []
}

const loadConfigModule = async (filePath) => {
	return import(`${pathToFileURL(filePath).href}?t=${Date.now()}`)
}

const resolveConfigPath = (value) => {
	if (!value) return null
	return isAbsolute(value) ? value : resolve(state.PROJECT_ROOT, value)
}

const buildConfigContext = (mode) => ({
	mode,
	root: state.PROJECT_ROOT,
	HTMLRenderer
})

export const loadUserConfig = async (mode, configPath = null) => {
	if (configPath) {
		const filePath = resolveConfigPath(configPath)
		if (!filePath || !existsSync(filePath)) {
			throw new Error(`Config file not found: ${configPath}`)
		}
		const mod = await loadConfigModule(filePath)
		const config = mod.default ?? mod
		if (typeof config !== 'function') {
			throw new Error(`Config must export a function: ${filePath}`)
		}
		return (await config(buildConfigContext(mode))) || {}
	}
	for (const name of CONFIG_FILENAMES) {
		const filePath = resolve(state.PROJECT_ROOT, name)
		if (!existsSync(filePath)) {
			continue
		}
		const mod = await loadConfigModule(filePath)
		const config = mod.default ?? mod
		if (typeof config !== 'function') {
			throw new Error(`Config must export a function: ${filePath}`)
		}
		return (await config(buildConfigContext(mode))) || {}
	}
	return {}
}

export const applyConfig = async (config, mode) => {
	const root = resolveRootPath(config.root)
	state.ROOT_DIR = root
	const configSiteName = cli.CLI_SITE_NAME ?? config.site?.name ?? null
	state.SITE_NAME = configSiteName || basename(root) || 'Methanol Site'
	state.USER_SITE = config.site && typeof config.site === 'object' ? { ...config.site } : null
	if (mode) {
		state.CURRENT_MODE = mode
	}
	// config.paths / config.dirs are intentionally ignored (deprecated)

	const pagesDirValue = cli.CLI_PAGES_DIR || config.pagesDir
	const componentsDirValue = cli.CLI_COMPONENTS_DIR || config.componentsDir
	const distDirValue = cli.CLI_OUTPUT_DIR || config.distDir
	const publicDirValue = cli.CLI_ASSETS_DIR ?? config.publicDir

	const resolvePagesFallback = () => {
		const pagesPath = resolveFromRoot(root, 'pages', 'pages')
		if (existsSync(pagesPath)) return pagesPath
		const docsPath = resolveFromRoot(root, 'docs', 'docs')
		if (existsSync(docsPath)) return docsPath
		return pagesPath
	}
	state.PAGES_DIR = pagesDirValue
		? resolveFromRoot(root, pagesDirValue, 'pages')
		: resolvePagesFallback()
	state.COMPONENTS_DIR = resolveFromRoot(root, componentsDirValue, 'components')
	state.STATIC_DIR = resolveOptionalPath(root, publicDirValue, 'public')
	state.BUILD_DIR = resolveFromRoot(root, config.buildDir, 'build')
	state.DIST_DIR = resolveFromRoot(root, distDirValue, 'dist')

	const userSpecifiedPagesDir = cli.CLI_PAGES_DIR != null || hasOwn(config, 'pagesDir')
	if (userSpecifiedPagesDir && !existsSync(state.PAGES_DIR)) {
		throw new Error(`Pages directory not found: ${state.PAGES_DIR}`)
	}
	const userSpecifiedComponentsDir = cli.CLI_COMPONENTS_DIR != null || hasOwn(config, 'componentsDir')
	if (userSpecifiedComponentsDir && !existsSync(state.COMPONENTS_DIR)) {
		throw new Error(`Components directory not found: ${state.COMPONENTS_DIR}`)
	}
	const userSpecifiedPublicDir = cli.CLI_ASSETS_DIR != null || hasOwn(config, 'publicDir')
	if (userSpecifiedPublicDir && state.STATIC_DIR !== false && !existsSync(state.STATIC_DIR)) {
		state.STATIC_DIR = resolveFromRoot(root, publicDirValue, 'public')
	}
	state.USER_PUBLIC_OVERRIDE = userSpecifiedPublicDir

	state.VIRTUAL_HTML_OUTPUT_ROOT = state.PAGES_DIR

	state.USER_THEME = config.theme || await defaultTheme()
	if (!state.USER_THEME?.root && !config.theme?.root) {
		throw new Error('Theme root is required.')
	}
	if (config.theme?.root) {
		state.USER_THEME.root = resolveFromRoot(root, config.theme.root)
	}
	const themeEnv = state.USER_THEME.env || createEnv()
	state.THEME_ENV = themeEnv
	rewindEnv.setParent(themeEnv)
	const themeRoot = state.USER_THEME.root || root
	const themeComponentDirValue = hasOwn(state.USER_THEME, 'componentsDir')
		? state.USER_THEME.componentsDir
		: './components'
	state.THEME_COMPONENTS_DIR = resolveThemeComponentDir(themeRoot, themeComponentDirValue)
	const themePagesDirValue = hasOwn(state.USER_THEME, 'pagesDir')
		? state.USER_THEME.pagesDir
		: './pages'
	state.THEME_PAGES_DIR = resolveThemePagesDir(themeRoot, themePagesDirValue)
	const themePublicDirValue = hasOwn(state.USER_THEME, 'publicDir')
		? state.USER_THEME.publicDir
		: './public'
	state.THEME_PUBLIC_DIR = resolveThemePublicDir(themeRoot, themePublicDirValue)
	if (hasOwn(state.USER_THEME, 'componentsDir') && state.THEME_COMPONENTS_DIR && !existsSync(state.THEME_COMPONENTS_DIR)) {
		throw new Error(`Theme components directory not found: ${state.THEME_COMPONENTS_DIR}`)
	}
	if (hasOwn(state.USER_THEME, 'pagesDir') && state.THEME_PAGES_DIR && !existsSync(state.THEME_PAGES_DIR)) {
		throw new Error(`Theme pages directory not found: ${state.THEME_PAGES_DIR}`)
	}
	if (hasOwn(state.USER_THEME, 'publicDir') && state.THEME_PUBLIC_DIR && !existsSync(state.THEME_PUBLIC_DIR)) {
		throw new Error(`Theme public directory not found: ${state.THEME_PUBLIC_DIR}`)
	}

	// Asset Merging Logic
	const userAssetsDir = userSpecifiedPublicDir 
		? resolveFromRoot(root, publicDirValue, 'public')
		: resolveFromRoot(root, 'public', 'public')
	
	const hasUserAssets = existsSync(userAssetsDir)
	state.USER_ASSETS_DIR = hasUserAssets ? userAssetsDir : null
	state.THEME_ASSETS_DIR = state.THEME_PUBLIC_DIR && existsSync(state.THEME_PUBLIC_DIR) ? state.THEME_PUBLIC_DIR : null

	if (state.STATIC_DIR !== false) {
		if (!hasUserAssets) {
			// Optimization: No user assets, just use theme assets directly
			state.STATIC_DIR = state.THEME_ASSETS_DIR
			state.MERGED_ASSETS_DIR = null
		} else {
			// We need to merge
			const nodeModulesPath = resolve(root, 'node_modules')
			if (existsSync(nodeModulesPath)) {
				state.MERGED_ASSETS_DIR = resolve(nodeModulesPath, '.methanol/assets')
			} else {
				state.MERGED_ASSETS_DIR = resolve(state.PAGES_DIR || resolve(root, 'pages'), '.methanol/assets')
			}
			state.STATIC_DIR = state.MERGED_ASSETS_DIR
		}
	} else {
		state.STATIC_DIR = false
		state.MERGED_ASSETS_DIR = null
	}

	state.SOURCES = normalizeSources(state.USER_THEME.sources, themeRoot)
	state.USER_VITE_CONFIG = config.vite || null
	state.USER_MDX_CONFIG = config.mdx || null
	state.RESOLVED_MDX_CONFIG = undefined
	state.RESOLVED_VITE_CONFIG = undefined
	state.PAGEFIND_ENABLED = resolvePagefindEnabled(config)
	state.PAGEFIND_OPTIONS = resolvePagefindOptions(config)
	state.PAGEFIND_BUILD = resolvePagefindBuild(config)
	state.USER_PRE_BUILD_HOOKS = normalizeHooks(config.preBuild)
	state.USER_POST_BUILD_HOOKS = normalizeHooks(config.postBuild)
	state.USER_PRE_BUNDLE_HOOKS = normalizeHooks(config.preBundle)
	state.USER_POST_BUNDLE_HOOKS = normalizeHooks(config.postBundle)
	state.THEME_PRE_BUILD_HOOKS = normalizeHooks(state.USER_THEME?.preBuild)
	state.THEME_POST_BUILD_HOOKS = normalizeHooks(state.USER_THEME?.postBuild)
	state.THEME_PRE_BUNDLE_HOOKS = normalizeHooks(state.USER_THEME?.preBundle)
	state.THEME_POST_BUNDLE_HOOKS = normalizeHooks(state.USER_THEME?.postBundle)
	const starryNight = resolveStarryNightConfig(config.starryNight)
	const cliCodeHighlighting = cli.CLI_CODE_HIGHLIGHTING
	if (cliCodeHighlighting != null) {
		state.STARRY_NIGHT_ENABLED = cliCodeHighlighting === true
		state.STARRY_NIGHT_OPTIONS = cliCodeHighlighting === true ? starryNight.options : null
	} else {
		state.STARRY_NIGHT_ENABLED = starryNight.enabled
		state.STARRY_NIGHT_OPTIONS = starryNight.enabled ? starryNight.options : null
	}

	if (cli.CLI_INTERMEDIATE_DIR) {
		state.INTERMEDIATE_DIR = resolveFromRoot(root, cli.CLI_INTERMEDIATE_DIR, 'build')
	} else if (config.intermediateDir) {
		state.INTERMEDIATE_DIR = resolveFromRoot(root, config.intermediateDir, 'build')
	} else if (cli.CLI_EMIT_INTERMEDIATE || config.emitIntermediate) {
		state.INTERMEDIATE_DIR = state.BUILD_DIR
	} else {
		state.INTERMEDIATE_DIR = null
	}
}

export const resolveUserMdxConfig = async () => {
	if (state.RESOLVED_MDX_CONFIG !== undefined) {
		return state.RESOLVED_MDX_CONFIG
	}
	const resolveConfig = async (config) => {
		if (!config) return {}
		if (typeof config === 'function') {
			return (
				(await config({
					mode: state.CURRENT_MODE,
					root: state.ROOT_DIR
				})) || {}
			)
		}
		return config || {}
	}
	const themeConfig = await resolveConfig(state.USER_THEME.mdx)
	const userConfig = await resolveConfig(state.USER_MDX_CONFIG)
	const merged = { ...themeConfig, ...userConfig }
	const themePlugins = themeConfig?.rehypePlugins
	const userPlugins = userConfig?.rehypePlugins
	if (themePlugins || userPlugins) {
		const normalize = (value) => (Array.isArray(value) ? value : value ? [value] : [])
		merged.rehypePlugins = [...normalize(themePlugins), ...normalize(userPlugins)]
	} else {
		merged.rehypePlugins = []
	}
	state.RESOLVED_MDX_CONFIG = merged
	return state.RESOLVED_MDX_CONFIG
}

export const resolveUserViteConfig = async (command) => {
	if (state.RESOLVED_VITE_CONFIG !== undefined) {
		return state.RESOLVED_VITE_CONFIG
	}
	const resolveConfig = async (config) => {
		if (!config) return null
		if (typeof config === 'function') {
			const isPreview = command === 'preview'
			return (
				(await config({
					mode: state.CURRENT_MODE,
					root: state.ROOT_DIR,
					command: isPreview ? 'serve' : command,
					isPreview
				})) || null
			)
		}
		return config || null
	}
	const themeConfig = await resolveConfig(state.USER_THEME.vite)
	const userConfig = await resolveConfig(state.USER_VITE_CONFIG)
	if (!themeConfig && !userConfig) {
		state.RESOLVED_VITE_CONFIG = null
		return null
	}
	state.RESOLVED_VITE_CONFIG = themeConfig
		? userConfig
			? mergeConfig(themeConfig, userConfig)
			: themeConfig
		: userConfig
	return state.RESOLVED_VITE_CONFIG
}
