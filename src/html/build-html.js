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
import { writeFile, mkdir, rm, readFile } from 'fs/promises'
import { resolve, dirname, relative, posix } from 'path'
import { parse as parseHtml, serialize as serializeHtml } from 'parse5'
import { normalizePath } from 'vite'
import { state, cli } from '../state.js'
import { resolveBasePrefix } from '../config.js'
import {
	hashMd5,
	splitUrlParts,
	isExternalUrl,
	resolveManifestKey,
	joinBasePrefix,
	getAttr,
	setAttr,
	getTextContent,
	walkNodes
} from './utils.js'

const ensureDir = async (dir) => {
	await mkdir(dir, { recursive: true })
}

const METHANOL_DIR = '.methanol'
const INLINE_DIR = 'inline'
const ENTRY_DIR = 'entries'

const resolveMethanolDir = () => resolve(state.PAGES_DIR, METHANOL_DIR)
const isStaticPath = (resolvedPath) => {
	if (!resolvedPath || !state.STATIC_DIR) return false
	if (!resolvedPath.startsWith('/')) return false
	return existsSync(resolve(state.STATIC_DIR, resolvedPath.slice(1)))
}

export async function scanHtmlEntries(entries, preScan = null, options = null) {
	const basePrefix = resolveBasePrefix()
	const methanolDir = resolveMethanolDir()
	const inlineDir = resolve(methanolDir, INLINE_DIR)
	const entriesDir = resolve(methanolDir, ENTRY_DIR)
	const assetsEntryPath = resolve(methanolDir, 'assets-entry.js')
	await ensureDir(inlineDir)
	await rm(entriesDir, { recursive: true, force: true })
	await ensureDir(entriesDir)
	const inlineCache = new Map()
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

	const addAssetUrl = (rawValue, routePath) => {
		if (!rawValue || isExternalUrl(rawValue)) return
		const { path } = splitUrlParts(rawValue)
		if (!path) return
		const resolved = resolveManifestKey(path, basePrefix, routePath)
		if (!resolved) return
		const { resolvedPath } = resolved
		if (!resolvedPath || resolvedPath === '/') return
		const publicCandidate =
			state.STATIC_DIR && resolvedPath.startsWith('/')
				? resolve(state.STATIC_DIR, resolvedPath.slice(1))
				: null
		if (publicCandidate && existsSync(publicCandidate)) {
			return
		}
		assetUrls.add(resolvedPath)
	}

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
			processedEntries += 1
			if (reportProgress) {
				reportProgress(processedEntries, totalEntries)
			}
			continue
		}

		const html = await readFile(entry.stagePath, 'utf-8')
		const document = parseHtml(html)
		let hasScripts = false

		await walkNodes(document, async (node) => {
			if (!node.tagName) return
			const tag = node.tagName.toLowerCase()
			if (tag === 'script') {
				const type = (getAttr(node, 'type') || '').toLowerCase()
				if (type !== 'module') return
				const src = getAttr(node, 'src')
				if (src) {
					const resolved = resolveManifestKey(src, basePrefix, entry.routePath)
					if (!resolved?.resolvedPath) return
					const resolvedPath = resolved.resolvedPath
					scriptCounts.set(resolvedPath, (scriptCounts.get(resolvedPath) || 0) + 1)
					if (!scriptOrder.has(resolvedPath)) {
						scriptOrder.set(resolvedPath, scriptIndex++)
					}
					hasScripts = true
					return
				}
				const content = getTextContent(node)
				if (!content) return
				const cached = inlineCache.get(content)
				const entryInfo = cached || (await createEntryModule('inline', null, content))
				inlineCache.set(content, entryInfo)
				hasScripts = true
				setAttr(node, 'type', 'module')
				setAttr(node, 'src', joinBasePrefix(basePrefix, entryInfo.publicUrl))
				node.childNodes = []
				return
			}

			if (tag === 'link') {
				const rel = (getAttr(node, 'rel') || '').toLowerCase()
				if (rel.includes('stylesheet')) {
					const href = getAttr(node, 'href')
					const resolved = resolveManifestKey(href, basePrefix, entry.routePath)
					if (!resolved?.resolvedPath) return
					if (isStaticPath(resolved.resolvedPath)) return
					stylePaths.add(resolved.resolvedPath)
					return
				}
				if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
					addAssetUrl(getAttr(node, 'href'), entry.routePath)
				}
				return
			}

			if (tag === 'img' || tag === 'source' || tag === 'video' || tag === 'audio') {
				addAssetUrl(getAttr(node, 'src'), entry.routePath)
				addAssetUrl(getAttr(node, 'poster'), entry.routePath)
				const srcset = getAttr(node, 'srcset')
				if (srcset) {
					for (const item of parseSrcset(srcset)) {
						addAssetUrl(item.url, entry.routePath)
					}
				}
			}
		})

		if (hasScripts) {
			pagesWithScripts++
		}

		const nextHtml = serializeHtml(document)
		await writeFile(entry.stagePath, nextHtml)

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
	const basePrefix = resolveBasePrefix()
	const entryModules = scanResult?.entryModules || []
	const scriptEntryMap = new Map()
	const styleEntryMap = new Map()
	for (const entry of entryModules) {
		if (!entry?.publicPath || !entry?.manifestKey) continue
		if (entry.kind === 'script') scriptEntryMap.set(entry.publicPath, entry)
		if (entry.kind === 'style') styleEntryMap.set(entry.publicPath, entry)
	}
	const commonScripts = new Set(scanResult?.commonScripts || [])
	const commonEntry = scanResult?.commonScriptEntry || null
	const commonManifestEntry = commonEntry?.manifestKey
		? manifest?.[commonEntry.manifestKey] || manifest?.[`/${commonEntry.manifestKey}`]
		: null
	let rewrittenScripts = 0
	let rewrittenStyles = 0
	const reportProgress = typeof options?.onProgress === 'function'
		? options.onProgress
		: null
	const totalEntries = entries.filter((entry) => entry.source !== 'static').length
	let processedEntries = 0
	for (const entry of entries) {
		if (entry.source === 'static') {
			continue
		}
		const html = await readFile(entry.stagePath, 'utf-8')
		const document = parseHtml(html)
		const cssFiles = new Set()
		let commonInserted = false
		const updateAttr = (node, key) => {
			const value = getAttr(node, key)
			if (!value || isExternalUrl(value)) return
			const { path, suffix } = splitUrlParts(value)
			const resolved = resolveManifestKey(path, basePrefix, entry.routePath)
			if (!resolved?.key) return
			const manifestEntry = resolveManifestEntry(manifest, resolved.key)
			if (!manifestEntry?.file) return
			setAttr(node, key, joinBasePrefix(basePrefix, manifestEntry.file) + suffix)
		}
		const updateSrcset = (node) => {
			const srcset = getAttr(node, 'srcset')
			if (!srcset) return
			const entries = srcset
				.split(',')
				.map((item) => item.trim())
				.filter(Boolean)
				.map((srcItem) => {
					const [url, ...rest] = srcItem.split(/\s+/)
					const { path, suffix } = splitUrlParts(url)
					const resolved = resolveManifestKey(path, basePrefix, entry.routePath)
					if (!resolved?.key) return srcItem
					const manifestEntry = resolveManifestEntry(manifest, resolved.key)
					if (!manifestEntry?.file) return srcItem
					const nextUrl = joinBasePrefix(basePrefix, manifestEntry.file) + suffix
					return [nextUrl, ...rest].filter(Boolean).join(' ')
				})
			setAttr(node, 'srcset', entries.join(', '))
		}
		const walk = (node, visitor) => {
			if (!node.childNodes) return
			const nextChildren = []
			for (const child of node.childNodes) {
				const action = visitor(child, node)
				if (action !== 'remove') {
					walk(child, visitor)
					nextChildren.push(child)
				}
			}
			node.childNodes = nextChildren
		}

		walk(document, (node) => {
			if (!node.tagName) return
			const tag = node.tagName.toLowerCase()
			if (tag === 'script') {
				const type = (getAttr(node, 'type') || '').toLowerCase()
				const src = getAttr(node, 'src')
				if (type === 'module' && src) {
					const resolved = resolveManifestKey(src, basePrefix, entry.routePath)
					if (!resolved?.resolvedPath) return
					if (commonScripts.has(resolved.resolvedPath)) {
						if (!commonManifestEntry?.file) return
						if (!commonInserted) {
							setAttr(node, 'src', joinBasePrefix(basePrefix, commonManifestEntry.file) + splitUrlParts(src).suffix)
							rewrittenScripts++
							commonInserted = true
							if (Array.isArray(commonManifestEntry.css)) {
								for (const css of commonManifestEntry.css) {
									cssFiles.add(css)
								}
							}
							return
						}
						return 'remove'
					}

					const entryInfo = scriptEntryMap.get(resolved.resolvedPath)
					if (!entryInfo?.manifestKey) return
					const manifestEntry = manifest?.[entryInfo.manifestKey] || manifest?.[`/${entryInfo.manifestKey}`] || null
					if (!manifestEntry?.file) return
					setAttr(node, 'src', joinBasePrefix(basePrefix, manifestEntry.file) + splitUrlParts(src).suffix)
					rewrittenScripts++
					if (Array.isArray(manifestEntry.css)) {
						for (const css of manifestEntry.css) {
							cssFiles.add(css)
						}
					}
				}
				return
			}

			if (tag === 'link') {
				const rel = (getAttr(node, 'rel') || '').toLowerCase()
				if (rel.includes('stylesheet')) {
					const href = getAttr(node, 'href')
					const resolved = resolveManifestKey(href, basePrefix, entry.routePath)
					if (!resolved?.resolvedPath) return
					if (isStaticPath(resolved.resolvedPath)) return
					const entryInfo = styleEntryMap.get(resolved.resolvedPath)
					let manifestEntry = null
					if (entryInfo?.manifestKey) {
						manifestEntry = manifest?.[entryInfo.manifestKey] || manifest?.[`/${entryInfo.manifestKey}`] || null
					} else {
						manifestEntry = resolveManifestEntry(manifest, resolved.key)
					}
					const css = manifestEntry?.css?.[0] || (manifestEntry?.file?.endsWith('.css') ? manifestEntry.file : null)
					if (!css) return
					setAttr(node, 'href', joinBasePrefix(basePrefix, css) + splitUrlParts(href).suffix)
					rewrittenStyles++
					if (manifestEntry?.css?.length > 1) {
						for (const extraCss of manifestEntry.css.slice(1)) {
							cssFiles.add(extraCss)
						}
					}
					return
				}
				if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
					updateAttr(node, 'href')
				}
				return
			}

			if (tag === 'img' || tag === 'source' || tag === 'video' || tag === 'audio') {
				updateAttr(node, 'src')
				updateAttr(node, 'poster')
				updateSrcset(node)
			}
		})

		if (cssFiles.size) {
			const head = (() => {
				let headNode = null
				walk(document, (node) => {
					if (headNode || !node.tagName) return
					if (node.tagName.toLowerCase() === 'head') {
						headNode = node
					}
				})
				return headNode
			})()

			if (head) {
				const existing = new Set()
				for (const child of head.childNodes || []) {
					if (!child.tagName || child.tagName.toLowerCase() !== 'link') continue
					const href = getAttr(child, 'href')
					if (href) existing.add(href)
				}
				for (const css of Array.from(cssFiles)) {
					const href = joinBasePrefix(basePrefix, css)
					if (existing.has(href)) continue
					head.childNodes.push({
						nodeName: 'link',
						tagName: 'link',
						attrs: [
							{ name: 'rel', value: 'stylesheet' },
							{ name: 'href', value: href }
						],
						childNodes: []
					})
				}
			}
		}

		const outPath = resolve(state.DIST_DIR, `${entry.name}.html`)
		await ensureDir(dirname(outPath))
		await writeFile(outPath, serializeHtml(document))
		processedEntries += 1
		if (reportProgress) {
			reportProgress(processedEntries, totalEntries)
		}
	}
	if (cli.CLI_VERBOSE) {
		console.log(`Build pipeline: rewrote ${rewrittenScripts} module scripts and ${rewrittenStyles} stylesheets`)
	}
}
