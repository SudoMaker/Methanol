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

import { lazy } from 'refui'
import fnv1a from '@sindresorhus/fnv1a'
import JSON5 from 'json5'

const utf8Buffer = new Uint8Array(128)

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!?*:+-=._/[]{}()<>%#$^|~`'"
const base = alphabet.length
function compress(num) {
	let result = ''
	while (num > 0) {
		result = alphabet[num % base] + result
		num = Math.floor(num / base)
	}
	return result
}

function hash(str, size = 32) {
	return compress(Number(fnv1a(str, { size, utf8Buffer })))
}

export function env(parentEnv) {
	const registry = {}
	const keyPathRegistry = {}
	let parent = parentEnv || null

	let renderCount = 0

	function register(info) {
		const { clientPath, staticPath, staticImportURL, exportName } = info

		if (!clientPath) {
			return lazy(() => import(staticImportURL))
		}

		let key = null
		let _clientPath = clientPath
		do {
			_clientPath += '\0'
			key = hash(_clientPath)
		} while (keyPathRegistry[key] && keyPathRegistry[key] !== clientPath)

		const component = async ({ children: childrenProp, ...props }, ...children) => {
			const staticComponent = (await import(staticImportURL)).default

			const id = renderCount++
			const idStr = id.toString(16)
			const script = `$$rfrm(${JSON.stringify(key)},${id},${Object.keys(props).length ? JSON5.stringify(props) : '{}'})`

			return (R) => {
				return [
					R.createAnchor(`{${idStr}}`, true),
					staticComponent ? R.c(
						staticComponent,
						props,
						R.createAnchor(`[${idStr}[`, true),
						...children,
						R.createAnchor(`]${idStr}]`, true)
					): null,
					R.c('script', null, R.rawHTML(script))
				]
			}
		}

		registry[exportName] = [key, info.clientPath]
		keyPathRegistry[key] = info.clientPath

		return component
	}

	function invalidate(exportName) {
		if (!registry[exportName]) {
			return
		}
		const [key] = registry[exportName]
		delete registry[exportName]
		delete keyPathRegistry[key]
	}

	function setParent(nextParent) {
		parent = nextParent || null
	}

	function getMergedRegistry() {
		return Object.assign({}, parent?.registry, registry)
	}

	function genRegistryScript() {
		return `({
	${Object.values(getMergedRegistry()).map(([key, path]) => `${JSON.stringify(key)}: () => import(${JSON.stringify(path)})`).join(`,
	`)}
})`
	}

	return {
		register,
		invalidate,
		genRegistryScript,
		setParent,
		get registry() {
			return getMergedRegistry()
		}
	}
}
