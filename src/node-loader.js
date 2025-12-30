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

import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve as pathResolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { transform } from 'esbuild'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const projectRoot = pathResolve('.', '__virtual__.js')
const projectRootURL = pathToFileURL(projectRoot)
export const projectRequire = createRequire(projectRootURL)

const require = createRequire(import.meta.url)

const EXTS = new Set(['.jsx', '.tsx', '.ts', '.mts', '.cts'])

export async function load(url, context, nextLoad) {
	if (url.startsWith('node:') || url.startsWith('data:')) {
		return nextLoad(url, context, nextLoad)
	}

	const pathname = new URL(url).pathname
	const ext = extname(pathname).toLowerCase()
	if (!EXTS.has(ext)) {
		return nextLoad(url, context, nextLoad)
	}

	const source = await readFile(fileURLToPath(url), 'utf-8')
	const loader = ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : 'ts'
	const result = await transform(source, {
		loader,
		format: 'esm',
		jsx: 'automatic',
		jsxImportSource: 'refui',
		sourcemap: 'inline',
		sourcefile: fileURLToPath(url)
	})

	return {
		format: 'module',
		shortCircuit: true,
		source: result.code
	}
}

const startPos = 'methanol'.length
export async function resolve(specifier, context, nextResolve) {
	if (specifier === 'refui' || specifier.startsWith('refui/')) {
		try {
			// Use user installed rEFui when possible
			return await nextResolve(specifier, { ...context, parentURL: projectRootURL })
		} catch (e) {
			return await nextResolve(specifier, { ...context, parentURL: import.meta.url })
		}
	} else if (specifier === 'methanol' || specifier.startsWith('methanol/')) {
		// Force only one Metnanol instance
		const filePath = require.resolve('..' + specifier.slice(startPos))
		return {
			__proto__: null,
			shortCircuit: true,
			format: 'module',
			url: pathToFileURL(filePath).href
		}
	} else {
		return await nextResolve(specifier, context)
	}
}
