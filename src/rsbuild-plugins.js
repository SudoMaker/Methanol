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

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import { rspack } from '@rsbuild/core'
import { state } from './state.js'
import { genRegistryScript } from './components.js'
import { serializePagesIndex } from './pages-index.js'
import { projectRequire } from './node-loader.js'
import {
	virtualModuleDir,
	PWA_INJECT_SCRIPT
} from './client/virtual-module/assets.js'

const PLUGIN_NAME = 'methanol-resolver'
const require = createRequire(import.meta.url)
const virtualRoot = '.methanol/virtual'

const virtualPaths = {
	registry: `${virtualRoot}/registry.js`,
	pages: `${virtualRoot}/pages.js`,
	'pwa-inject': `${virtualRoot}/pwa-inject.js`
}

const sourcePaths = {
	inject: resolve(virtualModuleDir, 'inject.js'),
	loader: resolve(virtualModuleDir, 'loader.js'),
	'pagefind-loader': resolve(virtualModuleDir, 'pagefind-loader.js')
}

const virtualPath = (key) => resolve(state.PAGES_DIR, virtualPaths[key])

const virtualContents = {
	registry: () => `export const registry = ${genRegistryScript()}`,
	pages: () => {
		const pages = state.PAGES_CONTEXT?.pages || []
		return `export const pages = JSON.parse(${serializePagesIndex(pages)})\nexport default pages`
	},
	'pwa-inject': () => state.PWA_ENABLED && state.CURRENT_MODE === 'production'
		? PWA_INJECT_SCRIPT()
		: ''
}

const splitRequest = (request) => {
	const index = request.search(/[?#]/)
	return index < 0
		? { path: request, suffix: '' }
		: { path: request.slice(0, index), suffix: request.slice(index) }
}

const replaceSourceAlias = (request) => {
	const { path, suffix } = splitRequest(request)
	for (const entry of state.SOURCES) {
		const { find, replacement } = entry
		if (!find || !replacement) continue
		if (typeof find === 'string') {
			if (path === find || path.startsWith(`${find}/`)) {
				return `${replacement}${path.slice(find.length)}${suffix}`
			}
			continue
		}
		if (find instanceof RegExp) {
			find.lastIndex = 0
			if (find.test(path)) {
				find.lastIndex = 0
				return `${path.replace(find, replacement)}${suffix}`
			}
		}
	}
	return null
}

const resolveMethanolRequest = (request) => {
	if (!request) return null
	if (request === 'refui' || request.startsWith('refui/')) {
		try {
			return projectRequire.resolve(request)
		} catch {
			return require.resolve(request)
		}
	}
	if (request === 'methanol' || request.startsWith('methanol/')) {
		return require.resolve(request)
	}
	if (request.startsWith('methanol:')) {
		const key = request.slice('methanol:'.length)
		if (sourcePaths[key]) return sourcePaths[key]
		if (virtualPaths[key]) return virtualPath(key)
		return null
	}

	const { path, suffix } = splitRequest(request)
	if (path.startsWith('/.methanol_virtual_module/')) {
		return `${resolve(virtualModuleDir, path.slice('/.methanol_virtual_module/'.length))}${suffix}`
	}
	if (path.startsWith('/.methanol/')) {
		return `${resolve(state.PAGES_DIR, '.methanol', path.slice('/.methanol/'.length))}${suffix}`
	}

	const aliased = replaceSourceAlias(request)
	if (aliased) return aliased

	if (path.startsWith('/') && !existsSync(path)) {
		const staticPath = state.STATIC_DIR && resolve(state.STATIC_DIR, path.slice(1))
		if (staticPath && existsSync(staticPath)) return `${staticPath}${suffix}`
		return `${resolve(state.PAGES_DIR, path.slice(1))}${suffix}`
	}
	return null
}

export class MethanolResolverPlugin {
	apply(compiler) {
		compiler.hooks.normalModuleFactory.tap(PLUGIN_NAME, (factory) => {
			factory.hooks.beforeResolve.tap(PLUGIN_NAME, (data) => {
				if (!data?.request) return
				const replacement = resolveMethanolRequest(data.request)
				if (replacement) data.request = replacement
			})
		})
	}
}

export class MethanolRefurbishPlugin {
	apply(compiler) {
		const importSourcePath = require.resolve('refui/hmr')
		const loader = require.resolve('refurbish/hmr-loader')
		compiler.options.module ||= {}
		compiler.options.module.rules ||= []
		compiler.options.module.rules.unshift({
			test: (path) => path === importSourcePath || /\.(?:jsx|tsx|mdx)$/.test(path),
			use: [{
				loader,
				options: { importSource: 'refui/hmr', importSourcePath }
			}]
		})
	}
}

export const createMethanolVirtualModules = () => {
	const modules = Object.fromEntries(
		Object.entries(virtualPaths).map(([key, path]) => [path, virtualContents[key]()])
	)
	const plugin = new rspack.experiments.VirtualModulesPlugin(modules)

	return {
		plugin: {
			apply(compiler) {
				plugin.apply(compiler)
			}
		},
		update(key) {
			if (!virtualPaths[key]) return
			plugin.writeModule(virtualPaths[key], virtualContents[key]())
		},
		updateRegistry() {
			this.update('registry')
		},
		updatePages() {
			this.update('pages')
		}
	}
}

export const sourceManifestKeys = (sourcePath) => {
	if (!sourcePath) return []
	let absolute = sourcePath
	if (!isAbsolute(absolute)) absolute = resolve(state.PAGES_DIR, absolute)
	const keys = new Set()
	const addRelative = (root, prefix = '') => {
		if (!root) return
		const relPath = relative(resolve(root), resolve(absolute))
		if (!relPath || isAbsolute(relPath) || relPath === '..' || relPath.startsWith('../') || relPath.startsWith('..\\')) {
			return
		}
		const normalized = relPath.replace(/\\/g, '/')
		keys.add(prefix ? `${prefix.replace(/^\//, '').replace(/\/$/, '')}/${normalized}` : normalized)
	}

	addRelative(state.PAGES_DIR)
	addRelative(state.THEME_PAGES_DIR)
	for (const entry of state.SOURCES) {
		if (typeof entry.find !== 'string') continue
		addRelative(entry.replacement, entry.find)
	}
	return Array.from(keys)
}
