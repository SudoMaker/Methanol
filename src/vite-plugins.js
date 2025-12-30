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

import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizePath } from 'vite'
import { state } from './state.js'
import { genRegistryScript } from './components.js'
import { INJECT_SCRIPT, LOADER_SCRIPT, PAGEFIND_SCRIPT } from './assets.js'
import { projectRequire } from './node-loader.js'

const require = createRequire(import.meta.url)

export const methanolVirtualHtmlPlugin = (htmlCache) => {
	const prefix = normalizePath(state.VIRTUAL_HTML_OUTPUT_ROOT + '/')
	return {
		name: 'methanol-virtual-html',
		resolveId(id) {
			const normalized = normalizePath(id)
			if (normalized.startsWith(prefix) && htmlCache.has(normalized)) {
				return normalized
			}
		},
		load(id) {
			const normalized = normalizePath(id)
			if (normalized.startsWith(prefix) && htmlCache.has(normalized)) {
				return htmlCache.get(normalized) ?? null
			}
		}
	}
}

export const methanolPreviewRoutingPlugin = (distDir, notFoundPath) => ({
	name: 'methanol-preview-routing',
	configurePreviewServer(server) {
		return () => {
			let cachedHtml = null
			const loadNotFoundHtml = async () => {
				if (!existsSync(notFoundPath)) return null
				if (cachedHtml != null) return cachedHtml
				cachedHtml = await readFile(notFoundPath, 'utf-8')
				return cachedHtml
			}
			const handler = async (req, res, next) => {
				if (!req.url || req.method !== 'GET') {
					return next()
				}
				const accept = req.headers.accept || ''
				let pathname = req.url
				try {
					pathname = new URL(req.url, 'http://methanol').pathname
					pathname = decodeURIComponent(pathname)
				} catch {}
				const hasTrailingSlash = pathname.endsWith('/') && pathname !== '/'
				if (pathname.includes('.') && !pathname.endsWith('.html')) {
					return next()
				}
				if (!pathname.endsWith('.html') && !accept.includes('text/html')) {
					return next()
				}
				const resolveHtmlPath = (value) => resolve(distDir, value.replace(/^\//, ''))
				const candidates = []
				if (pathname === '/' || pathname === '') {
					candidates.push(resolveHtmlPath('/index.html'))
				} else if (pathname.endsWith('.html')) {
					candidates.push(resolveHtmlPath(pathname))
				} else {
					candidates.push(resolveHtmlPath(`${pathname}.html`))
					candidates.push(resolveHtmlPath(`${pathname}/index.html`))
				}
				if (candidates.some((candidate) => existsSync(candidate))) {
					return next()
				}
				const html = await loadNotFoundHtml()
				if (!html) {
					return next()
				}
				res.statusCode = 404
				res.setHeader('Content-Type', 'text/html')
				res.end(html)
			}
			if (Array.isArray(server.middlewares.stack)) {
				server.middlewares.stack.unshift({ route: '', handle: handler })
			} else {
				server.middlewares.use(handler)
			}
		}
	}
})

const virtualModulePrefix = '/.methanol_virtual_module/'
const resolvedVirtualModulePrefix = '\0' + virtualModulePrefix

const virtualModuleMap = {
	get 'registry.js'() {
		return `export const registry = ${genRegistryScript()}`
	},
	'loader.js': LOADER_SCRIPT,
	'inject.js': INJECT_SCRIPT,
	'pagefind.js': PAGEFIND_SCRIPT
}

const getModuleIdSegment = (id, start) => {
	return new URL(id.slice(start), 'http://methanol').pathname.slice(1)
}

export const methanolResolverPlugin = () => {
	return {
		name: 'methanol-resolver',
		resolveId(id) {
			if (id === 'refui' || id.startsWith('refui/')) {
				try {
					return projectRequire.resolve(id)
				} catch {
					return require.resolve(id)
				}
			}

			if (id === 'methanol' || id.startsWith('methanol/')) {
				return require.resolve(id)
			}

			if (id.startsWith(virtualModulePrefix)) {
				const _moduleId = getModuleIdSegment(id, virtualModulePrefix.length)
				if (Object.prototype.hasOwnProperty.call(virtualModuleMap, _moduleId)) {
					return '\0' + id
				}
			}

			if (state.SOURCES.length) {
				const { pathname, search } = new URL(id, 'http://methanol')
				for (const entry of state.SOURCES) {
					const { find, replacement } = entry
					if (!find || !replacement) continue
					if (typeof find === 'string') {
						if (pathname === find || pathname.startsWith(`${find}/`)) {
							return `${replacement}${pathname.slice(find.length)}${search}`
						}
						continue
					}
					if (find instanceof RegExp && find.test(pathname)) {
						return `${pathname.replace(find, replacement)}${search}`
					}
				}
			}
		},
		load(id) {
			if (id.startsWith(resolvedVirtualModulePrefix)) {
				const _moduleId = getModuleIdSegment(id, resolvedVirtualModulePrefix.length)
				return virtualModuleMap[_moduleId]
			}
		}
	}
}
