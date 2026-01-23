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

import { writeFile, mkdir, rm } from 'fs/promises'
import { resolve, dirname, relative, posix } from 'path'
import { normalizePath } from 'vite'
import { state } from '../state.js'
import { hashMd5 } from './utils.js'

const ensureDir = async (dir) => {
	await mkdir(dir, { recursive: true })
}

const METHANOL_DIR = '.methanol'
const ENTRY_DIR = 'entries'

const resolveMethanolDir = () => resolve(state.PAGES_DIR, METHANOL_DIR)

export async function scanHtmlEntries(entries, preScan = null, options = null) {
	const methanolDir = resolveMethanolDir()
	const entriesDir = resolve(methanolDir, ENTRY_DIR)
	const assetsEntryPath = resolve(methanolDir, 'assets-entry.js')
	await rm(entriesDir, { recursive: true, force: true })
	await ensureDir(entriesDir)
	const assetUrls = new Set()
	const entryModules = []
	const scriptCounts = new Map()
	const scriptOrder = new Map()
	let scriptIndex = 0
	const stylePaths = new Set()
	let commonScriptEntry = null
	const commonScripts = new Set()
	let pagesWithScripts = 0

	const createEntryModule = async (kind, publicPath, contentOverride = null, extraImports = null) => {
		const hash = hashMd5(`${kind}:${publicPath || contentOverride || ''}`)
		const filename = `${kind}-${hash}.js`
		const fsPath = resolve(entriesDir, filename)
		const manifestKey = normalizePath(relative(state.PAGES_DIR, fsPath))
		const lines = []
		if (contentOverride) {
			lines.push(contentOverride)
		} else if (publicPath) {
			lines.push(`import ${JSON.stringify(publicPath)}`)
		}
		if (Array.isArray(extraImports) && extraImports.length) {
			for (const entry of extraImports) {
				if (!entry) continue
				lines.push(`import ${JSON.stringify(entry)}`)
			}
		}
		const content = lines.join('\n')
		await writeFile(fsPath, content)
		const entryInfo = {
			kind,
			publicPath,
			fsPath,
			manifestKey,
			publicUrl: `/${METHANOL_DIR}/${ENTRY_DIR}/${filename}`
		}
		entryModules.push(entryInfo)
		return entryInfo
	}

	// assetUrls are collected from worker scan results

	const parseSrcset = (value = '') =>
		value
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean)
			.map((entry) => {
				const [url, ...rest] = entry.split(/\s+/)
				return { url, descriptor: rest.join(' ') }
			})

	const reportProgress = typeof options?.onProgress === 'function'
		? options.onProgress
		: null
	const totalEntries = entries.filter((entry) => entry.source !== 'static').length
	let processedEntries = 0

	const sortedEntries = [...entries].sort((a, b) => {
		const left = a?.stagePath || a?.name || ''
		const right = b?.stagePath || b?.name || ''
		return left.localeCompare(right)
	})
	for (const entry of sortedEntries) {
		if (entry.source === 'static') {
			continue
		}
		if (preScan && preScan.has(entry.stagePath)) {
			const scanned = preScan.get(entry.stagePath)
			const scripts = Array.isArray(scanned?.scripts) ? scanned.scripts : []
			const styles = Array.isArray(scanned?.styles) ? scanned.styles : []
			const assets = Array.isArray(scanned?.assets) ? scanned.assets : []
			if (scripts.length > 0) {
				pagesWithScripts++
			}
			for (const script of scripts) {
				if (!scriptOrder.has(script)) {
					scriptOrder.set(script, scriptIndex++)
				}
				scriptCounts.set(script, (scriptCounts.get(script) || 0) + 1)
			}
			for (const style of styles) {
				stylePaths.add(style)
			}
			for (const asset of assets) {
				assetUrls.add(asset)
			}
		}

		processedEntries += 1
		if (reportProgress) {
			reportProgress(processedEntries, totalEntries)
		}
	}

	if (pagesWithScripts === 0) {
		return { entryModules: [], assetsEntryPath: null, commonScriptEntry: null, commonScripts: [] }
	}

	const commonScriptCandidates = Array.from(scriptCounts.entries())
		.filter(([, count]) => count === pagesWithScripts)
		.map(([script]) => script)
		.sort((a, b) => (scriptOrder.get(a) || 0) - (scriptOrder.get(b) || 0))

	const assetsEntryPublicUrl = assetUrls.size ? `/${METHANOL_DIR}/assets-entry.js` : null
	const extraImports = []

	for (const style of stylePaths) {
		const styleEntry = await createEntryModule('style', style)
		extraImports.push(styleEntry.publicUrl)
	}
	if (assetsEntryPublicUrl) {
		extraImports.push(assetsEntryPublicUrl)
	}

	if (commonScriptCandidates.length) {
		const commonImports = commonScriptCandidates
			.map((script) => `import ${JSON.stringify(script)}`)
			.join('\n')
		commonScriptEntry = await createEntryModule('script-common', null, commonImports, extraImports)
		for (const script of commonScriptCandidates) {
			commonScripts.add(script)
		}
	}

	for (const [script] of scriptCounts) {
		if (commonScripts.has(script)) continue
		if (!commonScriptEntry && extraImports.length) {
			await createEntryModule('script', script, null, extraImports)
			extraImports.length = 0
			continue
		}
		await createEntryModule('script', script)
	}

	await ensureDir(dirname(assetsEntryPath))
	const assetLines = Array.from(assetUrls)
		.sort()
		.map((url) => `import ${JSON.stringify(url)};`)
	if (assetLines.length) {
		const assetEntry = `${assetLines.join('\n')}`
		await writeFile(assetsEntryPath, assetEntry)
	} else {
		await rm(assetsEntryPath, { force: true })
	}

	return {
		entryModules,
		commonScripts: Array.from(commonScripts),
		commonScriptEntry,
		assetsEntryPath: assetLines.length ? assetsEntryPath : null
	}
}

const resolveManifestEntry = (manifest, key) => {
	if (!manifest || !key) return null
	if (manifest[key]) return manifest[key]
	if (manifest[`/${key}`]) return manifest[`/${key}`]
	const normalized = posix.normalize(key)
	if (manifest[normalized]) return manifest[normalized]
	if (manifest[`/${normalized}`]) return manifest[`/${normalized}`]
	return null
}

export async function rewriteHtmlEntries(entries, manifest, scanResult = null, options = null) {
	const reportProgress = typeof options?.onProgress === 'function'
		? options.onProgress
		: null
	const totalEntries = entries.filter((entry) => entry.source !== 'static').length
	let processedEntries = 0
	for (const entry of entries) {
		if (entry.source === 'static') {
			continue
		}
		processedEntries += 1
		if (reportProgress) {
			reportProgress(processedEntries, totalEntries)
		}
	}
}
