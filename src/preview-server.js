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
import { isAbsolute, relative, resolve } from 'path'
import { createRsbuild, mergeRsbuildConfig } from '@rsbuild/core'
import { state, cli } from './state.js'
import { resolveBasePrefix, resolveUserRsbuildConfig } from './config.js'

const createRoutingMiddleware = (distDir, notFoundPath) => {
	let cachedHtml = null
	const loadNotFoundHtml = async () => {
		if (!existsSync(notFoundPath)) return null
		if (cachedHtml != null) return cachedHtml
		cachedHtml = await readFile(notFoundPath, 'utf-8')
		return cachedHtml
	}
	const basePrefix = resolveBasePrefix()
	const resolveHtmlPath = (value) => {
		const root = resolve(distDir)
		const candidate = resolve(root, value.replace(/^\//, ''))
		const relPath = relative(root, candidate)
		if (
			isAbsolute(relPath) ||
			relPath === '..' ||
			relPath.startsWith('../') ||
			relPath.startsWith('..\\')
		) return null
		return candidate
	}

	return async (req, res, next) => {
		if (!req.url || req.method !== 'GET') return next()
		const accept = req.headers.accept || ''
		let pathname = req.url
		try {
			pathname = decodeURIComponent(new URL(req.url, 'http://methanol').pathname)
			if (basePrefix) {
				if (!pathname.startsWith(basePrefix)) return next()
				pathname = pathname.slice(basePrefix.length) || '/'
			}
		} catch {}
		if (pathname.includes('.') && !pathname.endsWith('.html')) return next()
		if (!pathname.endsWith('.html') && !accept.includes('text/html')) return next()

		const candidates = pathname === '/' || pathname === ''
			? [resolveHtmlPath('/index.html')]
			: pathname.endsWith('.html')
				? [resolveHtmlPath(pathname)]
				: [resolveHtmlPath(`${pathname}.html`), resolveHtmlPath(`${pathname}/index.html`)]
		if (candidates.some((candidate) => candidate && existsSync(candidate))) return next()
		const html = await loadNotFoundHtml()
		if (!html) return next()
		res.statusCode = 404
		res.setHeader('Content-Type', 'text/html')
		res.end(html)
	}
}

export const runRsbuildPreview = async () => {
	await resolveUserRsbuildConfig('preview')
	const distDir = resolve(state.DIST_DIR)
	if (!existsSync(distDir)) {
		console.error(`Dist directory not found: ${distDir}`)
		console.error('Run a production build before previewing.')
		process.exit(1)
	}
	const notFoundPath = resolve(distDir, '404.html')
	const printUrls = ({ urls }) => urls.map((url) => new URL(state.BUILD_BASE || '/', url).href)
	const baseConfig = {
		root: state.PAGES_DIR,
		logLevel: 'info',
		output: { distPath: { root: distDir } },
		server: {
			base: state.BUILD_BASE || '/',
			htmlFallback: false,
			publicDir: false,
			printUrls,
			setup: ({ server }) => {
				server.middlewares.use(createRoutingMiddleware(distDir, notFoundPath))
			}
		}
	}
	const userConfig = await resolveUserRsbuildConfig('preview')
	const finalConfig = userConfig ? mergeRsbuildConfig(baseConfig, userConfig) : baseConfig
	finalConfig.output = {
		...(finalConfig.output || {}),
		distPath: {
			...((typeof finalConfig.output?.distPath === 'object' && finalConfig.output.distPath) || {}),
			root: distDir
		}
	}
	finalConfig.server = {
		...(finalConfig.server || {}),
		base: state.BUILD_BASE || '/',
		htmlFallback: false,
		publicDir: false,
		printUrls
	}
	if (cli.CLI_PORT != null) finalConfig.server.port = cli.CLI_PORT
	if (cli.CLI_HOST !== null) finalConfig.server.host = cli.CLI_HOST
	const rsbuild = await createRsbuild({
		cwd: state.PAGES_DIR,
		callerName: 'methanol',
		config: finalConfig
	})
	await rsbuild.preview()
}
