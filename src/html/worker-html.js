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
import { mkdir, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { parse as parseHtml, serialize as serializeHtml } from 'parse5'
import { state } from '../state.js'
import { resolveBasePrefix } from '../config.js'
import {
	hashMd5,
	splitUrlParts,
	isExternalUrl,
	resolveManifestKey,
	joinBasePrefix,
	stripBasePrefix,
	getAttr,
	setAttr,
	getTextContent,
	walkNodes
} from './utils.js'

let inlineReady = false

const resolveMethanolDir = () => resolve(state.PAGES_DIR, '.methanol')
const isStaticPath = (resolvedPath) => {
	if (!resolvedPath || !state.STATIC_DIR) return false
	if (!resolvedPath.startsWith('/')) return false
	return existsSync(resolve(state.STATIC_DIR, resolvedPath.slice(1)))
}

const ensureInlineDir = async () => {
	if (inlineReady) return
	const inlineDir = resolve(resolveMethanolDir(), 'inline')
	await mkdir(inlineDir, { recursive: true })
	inlineReady = true
}

const applyPatches = (html, patches = []) => {
	if (!patches.length) return html
	const sorted = patches
		.filter((patch) => patch && typeof patch.start === 'number' && typeof patch.end === 'number')
		.sort((a, b) => (b.start - a.start) || (b.end - a.end))
	let out = html
	for (const patch of sorted) {
		out = `${out.slice(0, patch.start)}${patch.text ?? ''}${out.slice(patch.end)}`
	}
	return out
}

const rewriteInlineScripts = async (html, routePath) => {
	const basePrefix = resolveBasePrefix()
	const inlineDir = resolve(resolveMethanolDir(), 'inline')
	const patches = []
	const document = parseHtml(html, { sourceCodeLocationInfo: true })

	await walkNodes(document, async (node) => {
		if (!node.tagName) return
		const tag = node.tagName.toLowerCase()
		if (tag !== 'script') return
		const type = (getAttr(node, 'type') || '').toLowerCase()
		if (type !== 'module') return
		const src = getAttr(node, 'src')
		if (src) return
		const loc = node.sourceCodeLocation
		if (!loc || typeof loc.startOffset !== 'number' || typeof loc.endOffset !== 'number') return
		const content = getTextContent(node) || ''
		const hash = hashMd5(content)
		await ensureInlineDir()
		const filename = `inline-${hash}.js`
		const fsPath = resolve(inlineDir, filename)
		await writeFile(fsPath, content)
		const publicPath = `/.methanol/inline/${filename}`
		const srcAttr = `src="${joinBasePrefix(basePrefix, publicPath)}"`
		const replacement = `<script type="module" ${srcAttr}></script>`
		patches.push({ start: loc.startOffset, end: loc.endOffset, text: replacement })
	})

	if (!patches.length) {
		return { html, changed: false }
	}
	return { html: applyPatches(html, patches), changed: true }
}

const buildRewritePlan = async (html, routePath) => {
	const basePrefix = resolveBasePrefix()
	const staticDir = state.STATIC_DIR
	const scripts = new Set()
	const styles = new Set()
	const assets = new Set()
	const plan = {
		headEndOffset: null,
		scripts: [],
		styles: [],
		icons: [],
		media: []
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

	const addAsset = (rawValue) => {
		if (!rawValue || isExternalUrl(rawValue)) return
		const resolved = resolveManifestKey(rawValue, basePrefix, routePath)
		const resolvedPath = resolved?.resolvedPath
		if (!resolvedPath || resolvedPath === '/') return
		if (staticDir && resolvedPath.startsWith('/')) {
			const publicCandidate = resolve(staticDir, resolvedPath.slice(1))
			if (existsSync(publicCandidate)) return
		}
		assets.add(resolvedPath)
	}

	const document = parseHtml(html, { sourceCodeLocationInfo: true })
	await walkNodes(document, (node) => {
		if (!node.tagName) return
		const tag = node.tagName.toLowerCase()
		if (tag === 'head' && node.sourceCodeLocation?.endTag?.startOffset != null) {
			plan.headEndOffset = node.sourceCodeLocation.endTag.startOffset
			return
		}
		if (tag === 'script') {
			const type = (getAttr(node, 'type') || '').toLowerCase()
			if (type !== 'module') return
			const src = getAttr(node, 'src')
			if (!src) return
			const attrLoc = node.sourceCodeLocation?.attrs?.src
			const nodeLoc = node.sourceCodeLocation
			if (!attrLoc || nodeLoc?.startOffset == null || nodeLoc?.endOffset == null) return
			const resolved = resolveManifestKey(src, basePrefix, routePath)
			if (resolved?.resolvedPath) scripts.add(resolved.resolvedPath)
			plan.scripts.push({
				src,
				attr: { name: 'src', start: attrLoc.startOffset, end: attrLoc.endOffset },
				node: { start: nodeLoc.startOffset, end: nodeLoc.endOffset }
			})
			return
		}
		if (tag === 'link') {
			const rel = (getAttr(node, 'rel') || '').toLowerCase()
			const href = getAttr(node, 'href')
			const attrLoc = node.sourceCodeLocation?.attrs?.href
			if (rel.includes('stylesheet')) {
				if (href && attrLoc) {
					const resolved = resolveManifestKey(href, basePrefix, routePath)
					if (resolved?.resolvedPath && !isStaticPath(resolved.resolvedPath)) {
						styles.add(resolved.resolvedPath)
					} else {
						return
					}
					plan.styles.push({
						href,
						attr: { name: 'href', start: attrLoc.startOffset, end: attrLoc.endOffset }
					})
				}
				return
			}
			if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
				if (href && attrLoc) {
					addAsset(href)
					plan.icons.push({
						href,
						attr: { name: 'href', start: attrLoc.startOffset, end: attrLoc.endOffset }
					})
				}
			}
			return
		}
		if (tag === 'img' || tag === 'source' || tag === 'video' || tag === 'audio') {
			const attrs = node.sourceCodeLocation?.attrs || {}
			const entry = { src: null, poster: null, srcset: null }
			const src = getAttr(node, 'src')
			if (src && attrs.src) {
				addAsset(src)
				entry.src = { value: src, attr: { name: 'src', start: attrs.src.startOffset, end: attrs.src.endOffset } }
			}
			const poster = getAttr(node, 'poster')
			if (poster && attrs.poster) {
				addAsset(poster)
				entry.poster = {
					value: poster,
					attr: { name: 'poster', start: attrs.poster.startOffset, end: attrs.poster.endOffset }
				}
			}
			const srcset = getAttr(node, 'srcset')
			if (srcset && attrs.srcset) {
				for (const item of parseSrcset(srcset)) {
					addAsset(item.url)
				}
				entry.srcset = {
					value: srcset,
					attr: { name: 'srcset', start: attrs.srcset.startOffset, end: attrs.srcset.endOffset }
				}
			}
			if (entry.src || entry.poster || entry.srcset) {
				plan.media.push(entry)
			}
		}
	})

	return {
		plan,
		scan: {
			scripts: Array.from(scripts),
			styles: Array.from(styles),
			assets: Array.from(assets)
		}
	}
}

export const scanRenderedHtml = async (html, routePath) => {
	const inline = await rewriteInlineScripts(html, routePath)
	const nextHtml = inline.html
	const { plan, scan } = await buildRewritePlan(nextHtml, routePath)
	return {
		html: nextHtml,
		changed: inline.changed,
		plan,
		scan
	}
}

export const resolveManifestEntry = (manifest, key) => {
	if (!manifest || !key) return null
	if (manifest[key]) return manifest[key]
	if (manifest[`/${key}`]) return manifest[`/${key}`]
	return null
}

export const rewriteHtmlByPlan = (
	html,
	plan,
	routePath,
	basePrefix,
	manifest,
	scriptMap,
	styleMap,
	commonScripts,
	commonEntry
) => {
	if (!plan) return html
	const holes = []
	const cssFiles = new Set()
	const linkedHrefs = new Set()
	let commonInserted = false

	const addHole = (start, end, text) => {
		if (typeof start !== 'number' || typeof end !== 'number') return
		holes.push({ start, end, text })
	}

	const patchAttr = (attr, value) => {
		if (!attr || !attr.name) return
		addHole(attr.start, attr.end, `${attr.name}="${value}"`)
	}

	const resolveAssetValue = (rawValue) => {
		const { path, suffix } = splitUrlParts(rawValue)
		const resolved = resolveManifestKey(rawValue, basePrefix, routePath)
		if (!resolved?.resolvedPath) return null
		const manifestEntry = resolveManifestEntry(manifest, resolved.key)
		if (manifestEntry?.file) {
			return joinBasePrefix(basePrefix, manifestEntry.file) + suffix
		}
		if (!path?.startsWith('/') || !basePrefix || basePrefix === '/') return null
		if (stripBasePrefix(path, basePrefix) !== path) return null
		return joinBasePrefix(basePrefix, path) + suffix
	}

	for (const entry of plan.scripts || []) {
		const src = entry?.src
		const attr = entry?.attr
		const node = entry?.node
		if (!src || !attr) continue
		const resolved = resolveManifestKey(src, basePrefix, routePath)
		const publicPath = resolved?.resolvedPath
		if (!publicPath) continue
		if (commonScripts.has(publicPath)) {
			if (!commonEntry?.file) {
				continue
			}
			if (!commonInserted) {
				const newSrc = joinBasePrefix(basePrefix, commonEntry.file) + splitUrlParts(src).suffix
				patchAttr(attr, newSrc)
				commonInserted = true
				if (Array.isArray(commonEntry.css)) {
					for (const css of commonEntry.css) {
						cssFiles.add(css)
					}
				}
			} else if (node) {
				addHole(node.start, node.end, '')
			}
			continue
		}
		const entryInfo = scriptMap.get(publicPath)
		if (!entryInfo?.file) continue
		const newSrc = joinBasePrefix(basePrefix, entryInfo.file) + splitUrlParts(src).suffix
		patchAttr(attr, newSrc)
		if (Array.isArray(entryInfo.css)) {
			for (const css of entryInfo.css) {
				cssFiles.add(css)
			}
		}
	}

	for (const entry of plan.styles || []) {
		const href = entry?.href
		const attr = entry?.attr
		if (!href || !attr) continue
		const resolved = resolveManifestKey(href, basePrefix, routePath)
		const publicPath = resolved?.resolvedPath
		if (!publicPath) continue
		const entryInfo = styleMap.get(publicPath)
		if (!entryInfo?.file) {
			const manifestEntry = resolveManifestEntry(manifest, resolved.key)
			const cssFile = manifestEntry?.css?.[0] || (manifestEntry?.file?.endsWith('.css') ? manifestEntry.file : null)
			if (cssFile) {
				const newHref = joinBasePrefix(basePrefix, cssFile) + splitUrlParts(href).suffix
				patchAttr(attr, newHref)
				linkedHrefs.add(newHref)
				if (Array.isArray(manifestEntry?.css) && manifestEntry.css.length > 1) {
					for (const css of manifestEntry.css.slice(1)) {
						cssFiles.add(css)
					}
				}
				continue
			}
			if (cssFiles.size) {
				const [fallbackCss] = Array.from(cssFiles)
				if (fallbackCss) {
					const newHref = joinBasePrefix(basePrefix, fallbackCss) + splitUrlParts(href).suffix
					patchAttr(attr, newHref)
					linkedHrefs.add(newHref)
					continue
				}
			}
			linkedHrefs.add(href)
			continue
		}
		const newHref = joinBasePrefix(basePrefix, entryInfo.file) + splitUrlParts(href).suffix
		patchAttr(attr, newHref)
		linkedHrefs.add(newHref)
		if (Array.isArray(entryInfo.css)) {
			for (const css of entryInfo.css) {
				cssFiles.add(css)
			}
		}
	}

	for (const entry of plan.icons || []) {
		const href = entry?.href
		const attr = entry?.attr
		if (!href || !attr) continue
		const updated = resolveAssetValue(href)
		if (!updated) continue
		patchAttr(attr, updated)
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

	for (const entry of plan.media || []) {
		const src = entry?.src
		if (src?.value && src?.attr) {
			const updated = resolveAssetValue(src.value)
			if (updated) patchAttr(src.attr, updated)
		}
		const poster = entry?.poster
		if (poster?.value && poster?.attr) {
			const updated = resolveAssetValue(poster.value)
			if (updated) patchAttr(poster.attr, updated)
		}
		const srcset = entry?.srcset
		if (srcset?.value && srcset?.attr) {
			const updated = []
			let touched = false
			for (const item of parseSrcset(srcset.value)) {
				if (!item.url || isExternalUrl(item.url)) {
					updated.push([item.url, item.descriptor].filter(Boolean).join(' '))
					continue
				}
				const resolved = resolveManifestKey(item.url, basePrefix, routePath)
				if (!resolved?.resolvedPath) {
					updated.push([item.url, item.descriptor].filter(Boolean).join(' '))
					continue
				}
				const manifestEntry = resolveManifestEntry(manifest, resolved.key)
				if (!manifestEntry?.file) {
					updated.push([item.url, item.descriptor].filter(Boolean).join(' '))
					continue
				}
				const rewritten = joinBasePrefix(basePrefix, manifestEntry.file) + splitUrlParts(item.url).suffix
				updated.push([rewritten, item.descriptor].filter(Boolean).join(' '))
				touched = true
			}
			if (touched) {
				patchAttr(srcset.attr, updated.join(', '))
			}
		}
	}

	if (cssFiles.size) {
		const snippets = []
		for (const css of Array.from(cssFiles)) {
			const href = joinBasePrefix(basePrefix, css)
			if (linkedHrefs.has(href)) continue
			if (html.includes(`href="${href}"`) || html.includes(`href='${href}'`)) continue
			snippets.push(`<link rel="stylesheet" href="${href}">`)
		}
		if (snippets.length) {
			let insertAt = typeof plan.headEndOffset === 'number' ? plan.headEndOffset : null
			if (insertAt == null) {
				const index = html.indexOf('</head>')
				if (index >= 0) insertAt = index
			}
			if (insertAt != null) {
				addHole(insertAt, insertAt, snippets.join(''))
			}
		}
	}

	if (!holes.length) return html
	const sorted = holes.sort((a, b) => (a.start - b.start) || (b.end - a.end))
	const chunks = []
	const fills = []
	let cursor = 0
	for (const hole of sorted) {
		if (hole.start < cursor) continue
		chunks.push(html.slice(cursor, hole.start))
		fills.push(hole.text ?? '')
		cursor = hole.end
	}
	chunks.push(html.slice(cursor))
	return String.raw({ raw: chunks }, ...fills)
}

export const rewriteHtmlDocument = (
	document,
	routePath,
	basePrefix,
	manifest,
	scriptMap,
	styleMap,
	commonScripts,
	commonEntry
) => {
	const cssFiles = new Set()
	let commonInserted = false
	const parseSrcset = (value = '') =>
		value
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean)
			.map((entry) => {
				const [url, ...rest] = entry.split(/\s+/)
				return { url, descriptor: rest.join(' ') }
			})

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

	const updateAttr = (node, key) => {
		const value = getAttr(node, key)
		if (!value || isExternalUrl(value)) return
		const { path, suffix } = splitUrlParts(value)
		const resolved = resolveManifestKey(path, basePrefix, routePath)
		if (!resolved?.key) return
		const manifestEntry = resolveManifestEntry(manifest, resolved.key)
		if (!manifestEntry?.file) return
		setAttr(node, key, joinBasePrefix(basePrefix, manifestEntry.file) + suffix)
	}

	const updateSrcset = (node) => {
		const srcset = getAttr(node, 'srcset')
		if (!srcset) return
		const entries = parseSrcset(srcset).map((item) => {
			const { path, suffix } = splitUrlParts(item.url || '')
			const resolved = resolveManifestKey(path, basePrefix, routePath)
			if (!resolved?.key) return item
			const manifestEntry = resolveManifestEntry(manifest, resolved.key)
			if (!manifestEntry?.file) return item
			return {
				url: joinBasePrefix(basePrefix, manifestEntry.file) + suffix,
				descriptor: item.descriptor
			}
		})
		const merged = entries.map((item) => [item.url, item.descriptor].filter(Boolean).join(' '))
		setAttr(node, 'srcset', merged.join(', '))
	}

	walk(document, (node) => {
		if (!node.tagName) return
		const tag = node.tagName.toLowerCase()
		if (tag === 'script') {
			const type = (getAttr(node, 'type') || '').toLowerCase()
			const src = getAttr(node, 'src')
			if (type === 'module' && src) {
				const resolved = resolveManifestKey(src, basePrefix, routePath)
				if (!resolved?.resolvedPath) return
				if (commonScripts.has(resolved.resolvedPath)) {
					if (!commonEntry?.file) return
					if (!commonInserted) {
						setAttr(node, 'src', joinBasePrefix(basePrefix, commonEntry.file) + splitUrlParts(src).suffix)
						commonInserted = true
						if (Array.isArray(commonEntry.css)) {
							for (const css of commonEntry.css) {
								cssFiles.add(css)
							}
						}
						return
					}
					return 'remove'
				}
				const entryInfo = scriptMap.get(resolved.resolvedPath)
				if (!entryInfo?.file) return
				setAttr(node, 'src', joinBasePrefix(basePrefix, entryInfo.file) + splitUrlParts(src).suffix)
				if (Array.isArray(entryInfo.css)) {
					for (const css of entryInfo.css) {
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
				const resolved = resolveManifestKey(href, basePrefix, routePath)
				if (!resolved?.resolvedPath) return
				if (isStaticPath(resolved.resolvedPath)) return
				const entryInfo = styleMap.get(resolved.resolvedPath)
				if (!entryInfo?.file) {
					const manifestEntry = resolveManifestEntry(manifest, resolved.key)
					const cssFile = manifestEntry?.css?.[0] || (manifestEntry?.file?.endsWith('.css') ? manifestEntry.file : null)
					if (!cssFile) {
						if (cssFiles.size) {
							const [fallbackCss] = Array.from(cssFiles)
							if (fallbackCss) {
								setAttr(node, 'href', joinBasePrefix(basePrefix, fallbackCss) + splitUrlParts(href).suffix)
							}
						}
						return
					}
					setAttr(node, 'href', joinBasePrefix(basePrefix, cssFile) + splitUrlParts(href).suffix)
					if (Array.isArray(manifestEntry?.css) && manifestEntry.css.length > 1) {
						for (const css of manifestEntry.css.slice(1)) {
							cssFiles.add(css)
						}
					}
					return
				}
				setAttr(node, 'href', joinBasePrefix(basePrefix, entryInfo.file) + splitUrlParts(href).suffix)
				if (Array.isArray(entryInfo.css)) {
					for (const css of entryInfo.css) {
						cssFiles.add(css)
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
		let headNode = null
		walk(document, (node) => {
			if (headNode || !node.tagName) return
			if (node.tagName.toLowerCase() === 'head') {
				headNode = node
			}
		})
		if (headNode) {
			const existing = new Set()
			for (const child of headNode.childNodes || []) {
				if (!child.tagName || child.tagName.toLowerCase() !== 'link') continue
				const href = getAttr(child, 'href')
				if (href) existing.add(href)
			}
			for (const css of Array.from(cssFiles)) {
				const href = joinBasePrefix(basePrefix, css)
				if (existing.has(href)) continue
				headNode.childNodes.push({
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

	return serializeHtml(document)
}

export const rewriteHtmlContent = (
	html,
	plan,
	routePath,
	basePrefix,
	manifest,
	scriptMap,
	styleMap,
	commonScripts,
	commonEntry
) => {
	if (plan) {
		return rewriteHtmlByPlan(
			html,
			plan,
			routePath,
			basePrefix,
			manifest,
			scriptMap,
			styleMap,
			commonScripts,
			commonEntry
		)
	}
	const document = parseHtml(html)
	return rewriteHtmlDocument(
		document,
		routePath,
		basePrefix,
		manifest,
		scriptMap,
		styleMap,
		commonScripts,
		commonEntry
	)
}
