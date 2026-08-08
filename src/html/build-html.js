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

import { writeFile, readFile, mkdir, rm } from 'fs/promises'
import { resolve, dirname, relative, posix } from 'path'
import { normalizePath } from '../path-utils.js'
import { state } from '../state.js'
import { hashMd5 } from './utils.js'
import { scanRenderedHtml, rewriteHtmlContent } from './worker-html.js'

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
	const staticPlans = new Map()

	const createEntryModule = async (kind, publicPath, contentOverride = null) => {
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
	const totalEntries = entries.length
	let processedEntries = 0

	const sortedEntries = [...entries].sort((a, b) => {
		const left = a?.stagePath || a?.name || ''
		const right = b?.stagePath || b?.name || ''
		return left.localeCompare(right)
	})
	for (const entry of sortedEntries) {
		let scanned = preScan?.get(entry.stagePath) || null
		if (entry.source === 'static' && entry.stagePath) {
			const source = await readFile(entry.stagePath, 'utf-8')
			const result = await scanRenderedHtml(source, entry.routePath)
			scanned = result.scan
			staticPlans.set(entry.stagePath, result.plan)
			if (result.changed) {
				await writeFile(entry.stagePath, result.html)
			}
		}
		if (scanned) {
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

	const commonScriptCandidates = Array.from(scriptCounts.entries())
		.filter(([, count]) => count === pagesWithScripts)
		.map(([script]) => script)
		.sort((a, b) => (scriptOrder.get(a) || 0) - (scriptOrder.get(b) || 0))

	for (const style of stylePaths) {
		await createEntryModule('style', style)
	}

	if (commonScriptCandidates.length) {
		const commonImports = commonScriptCandidates
			.map((script) => `import ${JSON.stringify(script)}`)
			.join('\n')
		commonScriptEntry = await createEntryModule('script-common', null, commonImports)
		for (const script of commonScriptCandidates) {
			commonScripts.add(script)
		}
	}

	for (const [script] of scriptCounts) {
		if (commonScripts.has(script)) continue
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
		assetsEntryPath: assetLines.length ? assetsEntryPath : null,
		staticPlans
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
	const staticEntries = entries.filter((entry) => entry.source === 'static')
	const totalEntries = staticEntries.length
	let processedEntries = 0
	const entryModules = Array.isArray(scanResult?.entryModules) ? scanResult.entryModules : []
	const scriptMap = new Map()
	const styleMap = new Map()
	for (const module of entryModules) {
		if (!module?.publicPath || !module?.manifestKey) continue
		const manifestEntry = resolveManifestEntry(manifest, module.manifestKey)
		if (!manifestEntry?.file) continue
		if (module.kind === 'script') {
			scriptMap.set(module.publicPath, {
				file: manifestEntry.file,
				js: manifestEntry.js || null,
				css: manifestEntry.css || null
			})
		}
		if (module.kind === 'style') {
			const cssFile = manifestEntry.css?.[0] || (manifestEntry.file.endsWith('.css') ? manifestEntry.file : null)
			if (cssFile) {
				styleMap.set(module.publicPath, { file: cssFile, css: manifestEntry.css || null })
			}
		}
	}
	const commonScripts = new Set(scanResult?.commonScripts || [])
	const commonKey = scanResult?.commonScriptEntry?.manifestKey
	const commonEntry = commonKey ? resolveManifestEntry(manifest, commonKey) : null
	const basePrefix = (await import('../config.js')).resolveBasePrefix()
	for (const entry of staticEntries) {
		const stagePath = entry.stagePath || entry.inputPath
		if (!stagePath) continue
		const html = await readFile(stagePath, 'utf-8')
		const plan = scanResult?.staticPlans?.get(stagePath) || null
		const output = rewriteHtmlContent(
			html,
			plan,
			entry.routePath,
			basePrefix,
			manifest,
			scriptMap,
			styleMap,
			commonScripts,
			commonEntry
		)
		const distPath = resolve(state.DIST_DIR, `${entry.name}.html`)
		await ensureDir(dirname(distPath))
		await writeFile(distPath, output)
		processedEntries += 1
		if (reportProgress) {
			reportProgress(processedEntries, totalEntries)
		}
	}
}
