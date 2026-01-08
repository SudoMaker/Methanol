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
import { resolve } from 'path'
import { mergeConfig, preview as vitePreview } from 'vite'
import { state, cli } from './state.js'
import { resolveUserViteConfig } from './config.js'
import { methanolPreviewRoutingPlugin } from './vite-plugins.js'

export const runVitePreview = async () => {
	const baseConfig = {
		configFile: false,
		appType: 'mpa',
		root: state.PAGES_DIR,
		build: {
			outDir: state.DIST_DIR
		}
	}
	const userConfig = await resolveUserViteConfig('preview')
	const finalConfig = userConfig ? mergeConfig(baseConfig, userConfig) : baseConfig
	if (cli.CLI_PORT != null) {
		finalConfig.preview = { ...(finalConfig.preview || {}), port: cli.CLI_PORT }
	}
	if (cli.CLI_HOST !== null) {
		finalConfig.preview = { ...(finalConfig.preview || {}), host: cli.CLI_HOST }
	}
	const outDir = finalConfig.build?.outDir || state.DIST_DIR
	const distDir = resolve(state.ROOT_DIR, outDir)
	const notFoundPath = resolve(distDir, '404.html')
	const previewPlugins = Array.isArray(finalConfig.plugins) ? [...finalConfig.plugins] : []
	previewPlugins.push(methanolPreviewRoutingPlugin(distDir, notFoundPath))
	finalConfig.plugins = previewPlugins
	if (!existsSync(distDir)) {
		console.error(`Dist directory not found: ${distDir}`)
		console.error('Run a production build before previewing.')
		process.exit(1)
	}
	const server = await vitePreview(finalConfig)
	server.printUrls()
}
