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

import { readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, extname, basename } from 'path'
import { pathToFileURL } from 'url'
import { env } from './reframe.js'
import { state } from './state.js'

const normalizeComponentName = (value) => basename(value)
const isInternalComponentName = (name) => {
	const normalized = normalizeComponentName(name)
	return normalized.startsWith('_') || normalized.startsWith('.')
}
const isIgnoredEntry = (name) => name.startsWith('.')

const COMPONENT_NAME_PATTERN = /^[^.]+(?:\.(client|static))?\.(jsx?|tsx?)$/i

export const isComponentFile = (name) =>
	/\.(jsx?|tsx?)$/i.test(normalizeComponentName(name)) &&
	!isInternalComponentName(name) &&
	COMPONENT_NAME_PATTERN.test(normalizeComponentName(name))
export const isClientComponent = (name) => /\.client\.(jsx?|tsx?)$/i.test(normalizeComponentName(name))
export const COMPONENT_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx']

let componentImportNonce = Date.now()
export const bumpComponentImportNonce = () => {
	componentImportNonce = Date.now()
	return componentImportNonce
}

export const reframeEnv = env()
export const register = reframeEnv.register
export const invalidateRegistryEntry = reframeEnv.invalidate
export const genRegistryScript = reframeEnv.genRegistryScript

const resolveComponentExport = (componentPath, exportName, ext) => {
	const staticCandidate = `${componentPath}.static${ext}`
	const clientCandidate = `${componentPath}.client${ext}`
	const genericCandidate = `${componentPath}${ext}`
	const ret = { exportName }

	if (existsSync(staticCandidate)) {
		ret.staticPath = staticCandidate
	}

	if (existsSync(clientCandidate)) {
		ret.clientPath = clientCandidate
	}

	if (!ret.staticPath) {
		if (existsSync(genericCandidate)) {
			ret.staticPath = genericCandidate
		} else if (existsSync(clientCandidate)) {
			ret.staticPath = clientCandidate
		}
	}

	if (ret.staticPath) {
		ret.staticImportURL = `${pathToFileURL(ret.staticPath).href}?t=${componentImportNonce}`
	}

	return ret
}

export const buildComponentEntry = async ({ dir, exportName, ext, register: registerFn = register }) => {
	const info = resolveComponentExport(join(dir, exportName), exportName, ext)
	if (!info.staticPath) {
		return { component: null, hasClient: false, staticPath: null, clientPath: null }
	}

	return {
		component: registerFn(info),
		hasClient: Boolean(info.clientPath),
		staticPath: info.staticPath,
		clientPath: info.clientPath || null
	}
}

export const buildComponentRegistry = async ({ componentsDir = state.COMPONENTS_DIR, register: registerFn = register } = {}) => {
	const components = {}
	const sources = new Map()

	if (!componentsDir || !existsSync(componentsDir)) {
		return { components, sources }
	}

	const walk = async (dir) => {
		const entries = await readdir(dir)
		for (const entry of entries) {
			if (isIgnoredEntry(entry)) {
				continue
			}
			const fullPath = join(dir, entry)
			const stats = await stat(fullPath)
			if (stats.isDirectory()) {
				await walk(fullPath)
				continue
			}
			if (!isComponentFile(entry)) {
				continue
			}

			const exportName = entry.split('.')[0]
			if (sources.has(exportName)) {
				continue
			}

			const { component, staticPath } = await buildComponentEntry({
				dir,
				exportName,
				ext: extname(entry),
				register: registerFn
			})
			if (!component) continue
			components[exportName] = component
			if (staticPath) {
				sources.set(exportName, staticPath)
			}
		}
	}

	await walk(componentsDir)
	return { components, sources }
}
