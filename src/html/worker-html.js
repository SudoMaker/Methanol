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
import { Parser } from 'htmlparser2'
import { state } from '../state.js'
import { resolveBasePrefix } from '../config.js'
import {
	hashMd5,
	splitUrlParts,
	isExternalUrl,
	resolveManifestKey,
	joinBasePrefix,
	stripBasePrefix
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

const escapeAttr = (value) =>
	String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')

const serializeAttrs = (attrs = {}) => {
	const entries = Object.entries(attrs)
		.filter(([name, value]) => name && value != null)
		.map(([name, value]) => {
			if (value === '') return name
			return `${name}="${escapeAttr(value)}"`
		})
	return entries.length ? ` ${entries.join(' ')}` : ''
}

const serializeTag = (tag, attrs = {}, { closeTag = false } = {}) => {
	const attrText = serializeAttrs(attrs)
	if (closeTag) {
		return `<${tag}${attrText}></${tag}>`
	}
	return `<${tag}${attrText}>`
}

const rewriteInlineScripts = async (html, routePath) => {
	const basePrefix = resolveBasePrefix()
	const inlineDir = resolve(resolveMethanolDir(), 'inline')
	const patches = []
	const inlineScripts = []
	let current = null
	const resolveTagEnd = (index) => {
		if (typeof index !== 'number') return index
		if (html[index] === '>') return index + 1
		const next = html.indexOf('>', index)
		return next >= 0 ? next + 1 : index + 1
	}

	const parser = new Parser(
		{
			onopentag(name, attrs) {
				if (name !== 'script') return
				const type = (attrs?.type || '').toLowerCase()
				const src = attrs?.src
				if (type !== 'module' || src) {
					current = null
					return
				}
				current = {
					start: parser.startIndex,
					end: null,
					content: ''
				}
			},
			ontext(text) {
				if (current) {
					current.content += text
				}
			},
			onclosetag(name) {
				if (name !== 'script' || !current) return
				current.end = resolveTagEnd(parser.endIndex)
				inlineScripts.push(current)
				current = null
			}
		},
		{
			decodeEntities: false,
			lowerCaseTags: true,
			lowerCaseAttributeNames: true
		}
	)

	parser.write(html)
	parser.end()

	if (!inlineScripts.length) {
		return { html, changed: false }
	}

	for (const entry of inlineScripts) {
		const content = entry.content || ''
		const hash = hashMd5(content)
		await ensureInlineDir()
		const filename = `inline-${hash}.js`
		const fsPath = resolve(inlineDir, filename)
		await writeFile(fsPath, content)
		const publicPath = `/.methanol/inline/${filename}`
		const srcAttr = `src="${joinBasePrefix(basePrefix, publicPath)}"`
		const replacement = `<script type="module" ${srcAttr}></script>`
		patches.push({ start: entry.start, end: entry.end, text: replacement })
	}

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
	const resolveTagEnd = (index) => {
		if (typeof index !== 'number') return index
		if (html[index] === '>') return index + 1
		const next = html.indexOf('>', index)
		return next >= 0 ? next + 1 : index + 1
	}
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

	const scriptStack = []
	const parser = new Parser(
		{
			onopentag(name, attrs) {
				const tag = name?.toLowerCase?.() || name
				const start = parser.startIndex
				const end = resolveTagEnd(parser.endIndex)

				if (tag === 'script') {
					const type = (attrs?.type || '').toLowerCase()
					const src = attrs?.src
					const resolved = type === 'module' && src
						? resolveManifestKey(src, basePrefix, routePath)
						: null
					const entry = {
						tag,
						attrs: { ...(attrs || {}) },
						src,
						start,
						end,
						resolvedPath: resolved?.resolvedPath || null,
						manifestKey: resolved?.key || null
					}
					scriptStack.push(entry)
					if (entry.resolvedPath) {
						scripts.add(entry.resolvedPath)
					}
					return
				}

				if (tag === 'link') {
					const rel = (attrs?.rel || '').toLowerCase()
					const href = attrs?.href
					if (rel.includes('stylesheet')) {
						const resolved = href ? resolveManifestKey(href, basePrefix, routePath) : null
						if (resolved?.resolvedPath && !isStaticPath(resolved.resolvedPath)) {
							styles.add(resolved.resolvedPath)
							plan.styles.push({
								tag,
								attrs: { ...(attrs || {}) },
								href,
								start,
								end,
								resolvedPath: resolved.resolvedPath,
								manifestKey: resolved.key
							})
						}
						return
					}
					if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
						if (href) {
							addAsset(href)
							plan.icons.push({
								tag,
								attrs: { ...(attrs || {}) },
								href,
								start,
								end
							})
						}
					}
					return
				}

				if (tag === 'img' || tag === 'source' || tag === 'video' || tag === 'audio') {
					const entry = {
						tag,
						attrs: { ...(attrs || {}) },
						start,
						end
					}
					const src = attrs?.src
					if (src) addAsset(src)
					const poster = attrs?.poster
					if (poster) addAsset(poster)
					const srcset = attrs?.srcset
					if (srcset) {
						for (const item of parseSrcset(srcset)) {
							addAsset(item.url)
						}
					}
					if (src || poster || srcset) {
						plan.media.push(entry)
					}
				}
			},
			onclosetag(name) {
				const tag = name?.toLowerCase?.() || name
				if (tag !== 'script') return
				const entry = scriptStack.pop()
				if (!entry || !entry.resolvedPath) return
				entry.end = resolveTagEnd(parser.endIndex)
				plan.scripts.push(entry)
			}
		},
		{
			decodeEntities: false,
			lowerCaseTags: true,
			lowerCaseAttributeNames: true
		}
	)

	parser.write(html)
	parser.end()

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

	const replaceTag = (entry, tag, attrs, { closeTag = false } = {}) => {
		if (!entry || typeof entry.start !== 'number' || typeof entry.end !== 'number') return
		addHole(entry.start, entry.end, serializeTag(tag, attrs, { closeTag }))
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
		const src = entry?.src || entry?.attrs?.src
		if (!src) continue
		const resolved = resolveManifestKey(src, basePrefix, routePath)
		const publicPath = resolved?.resolvedPath
		if (!publicPath) continue
		const attrs = { ...(entry.attrs || {}) }
		if (commonScripts.has(publicPath)) {
			if (!commonEntry?.file) {
				continue
			}
			if (!commonInserted) {
				const newSrc = joinBasePrefix(basePrefix, commonEntry.file) + splitUrlParts(src).suffix
				attrs.src = newSrc
				replaceTag(entry, 'script', attrs, { closeTag: true })
				commonInserted = true
				if (Array.isArray(commonEntry.css)) {
					for (const css of commonEntry.css) {
						cssFiles.add(css)
					}
				}
			} else {
				addHole(entry.start, entry.end, '')
			}
			continue
		}
		const entryInfo = scriptMap.get(publicPath)
		if (!entryInfo?.file) continue
		const newSrc = joinBasePrefix(basePrefix, entryInfo.file) + splitUrlParts(src).suffix
		attrs.src = newSrc
		replaceTag(entry, 'script', attrs, { closeTag: true })
		if (Array.isArray(entryInfo.css)) {
			for (const css of entryInfo.css) {
				cssFiles.add(css)
			}
		}
	}

	for (const entry of plan.styles || []) {
		const href = entry?.href || entry?.attrs?.href
		if (!href) continue
		const resolved = resolveManifestKey(href, basePrefix, routePath)
		const publicPath = resolved?.resolvedPath
		if (!publicPath) continue
		const attrs = { ...(entry.attrs || {}) }
		const entryInfo = styleMap.get(publicPath)
		if (!entryInfo?.file) {
			const manifestEntry = resolveManifestEntry(manifest, resolved.key)
			const cssFile = manifestEntry?.css?.[0] || (manifestEntry?.file?.endsWith('.css') ? manifestEntry.file : null)
			if (cssFile) {
				const newHref = joinBasePrefix(basePrefix, cssFile) + splitUrlParts(href).suffix
				attrs.href = newHref
				replaceTag(entry, 'link', attrs)
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
					attrs.href = newHref
					replaceTag(entry, 'link', attrs)
					linkedHrefs.add(newHref)
					continue
				}
			}
			linkedHrefs.add(href)
			continue
		}
		const newHref = joinBasePrefix(basePrefix, entryInfo.file) + splitUrlParts(href).suffix
		attrs.href = newHref
		replaceTag(entry, 'link', attrs)
		linkedHrefs.add(newHref)
		if (Array.isArray(entryInfo.css)) {
			for (const css of entryInfo.css) {
				cssFiles.add(css)
			}
		}
	}

	for (const entry of plan.icons || []) {
		const href = entry?.href || entry?.attrs?.href
		if (!href) continue
		const updated = resolveAssetValue(href)
		if (!updated) continue
		const attrs = { ...(entry.attrs || {}) }
		attrs.href = updated
		replaceTag(entry, 'link', attrs)
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
		if (!entry?.attrs) continue
		const attrs = { ...(entry.attrs || {}) }
		let touched = false
		if (attrs.src) {
			const updated = resolveAssetValue(attrs.src)
			if (updated) {
				attrs.src = updated
				touched = true
			}
		}
		if (attrs.poster) {
			const updated = resolveAssetValue(attrs.poster)
			if (updated) {
				attrs.poster = updated
				touched = true
			}
		}
		if (attrs.srcset) {
			const updated = []
			let changed = false
			for (const item of parseSrcset(attrs.srcset)) {
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
				changed = true
			}
			if (changed) {
				attrs.srcset = updated.join(', ')
				touched = true
			}
		}
		if (touched) {
			replaceTag(entry, entry.tag || 'img', attrs)
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
	if (!plan) return html
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
