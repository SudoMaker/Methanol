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

import { parentPort, workerData } from 'worker_threads'

const { mode = 'production', configPath = null, cli: cliOverrides = null } = workerData || {}
let initPromise = null
let compileMdxSource = null

const ensureInit = async () => {
	if (initPromise) return initPromise
	initPromise = (async () => {
		const { loadUserConfig, applyConfig } = await import('../config.js')
		const { cli } = await import('../state.js')
		if (cliOverrides) {
			Object.assign(cli, cliOverrides)
		}
		const mdx = await import('../mdx.js')
		compileMdxSource = mdx.compileMdxSource
		const config = await loadUserConfig(mode, configPath)
		await applyConfig(config, mode)
	})()
	return initPromise
}

const serializeError = (error) => {
	if (!error) return 'Unknown error'
	if (error.stack) return error.stack
	if (error.message) return error.message
	return String(error)
}

parentPort?.on('message', async (message) => {
	const { id, path, content, frontmatter } = message || {}
	try {
		await ensureInit()
		const result = await compileMdxSource({ content, path, frontmatter })
		parentPort?.postMessage({ id, result })
	} catch (error) {
		parentPort?.postMessage({ id, error: serializeError(error) })
	}
})
