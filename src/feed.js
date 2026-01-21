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

import { dirname, resolve } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { state } from './state.js'
import { HTMLRenderer } from './renderer.js'
import { extractExcerpt } from './text-utils.js'
import { withBase } from './config.js'
import { logger } from './logger.js'
import { setReframeHydrationEnabled, getReframeHydrationEnabled } from './components.js'
import RssFeed from './templates/rss-feed.jsx'
import AtomFeed from './templates/atom-feed.jsx'

const DEFAULT_RSS_PATH = '/rss.xml'
const DEFAULT_ATOM_PATH = '/atom.xml'
const DEFAULT_RSS_LIMIT = 10

const isAbsoluteUrl = (value) =>
	typeof value === 'string' && /^https?:\/\//i.test(value.trim())

const normalizeFeedPath = (value, isAtom) => {
	if (!value || typeof value !== 'string') return isAtom ? DEFAULT_ATOM_PATH : DEFAULT_RSS_PATH
	const trimmed = value.trim()
	if (!trimmed) return isAtom ? DEFAULT_ATOM_PATH : DEFAULT_RSS_PATH
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

const ensureDir = async (dir) => {
	await mkdir(dir, { recursive: true })
}

const wrapCdata = (value) => {
	const text = value == null ? '' : String(value)
	if (!text) return ''
	const trimmed = text.trim()
	if (trimmed.startsWith('<![CDATA[') && trimmed.endsWith(']]>')) {
		return trimmed
	}
	return `<![CDATA[${text.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
}

const escapeXml = (value) => {
	const text = value == null ? '' : String(value)
	if (!text) return ''
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}

const resolveSiteUrl = (options, site) => {
	if (options?.siteUrl) return options.siteUrl
	if (state.SITE_BASE) return state.SITE_BASE
	if (site?.base) return site.base
	return null
}

const buildItem = (page, siteUrl, htmlContent = null, isAtom = false) => {
	if (!page) return null
	const href = page.routeHref || withBase(page.routePath)
	if (!href) return null
	const link = new URL(href, siteUrl).href
	const title = page.title || page.name || page.routePath || link
	const description = extractExcerpt(page)
	const contentSource = htmlContent || page.content || ''
	const content = contentSource
		? (isAtom
			? HTMLRenderer.rawHTML(escapeXml(contentSource))
			: HTMLRenderer.rawHTML(wrapCdata(contentSource)))
		: null
	const pubDate = page.date ? new Date(page.date).toUTCString() : null
	const updated = page.date ? new Date(page.date).toISOString() : null
	return {
		title,
		link,
		description,
		content,
		pubDate,
		updated
	}
}

const getSortTime = (page) => {
	const value = page?.date
	if (!value) return 0
	const time = Date.parse(value)
	return Number.isNaN(time) ? 0 : time
}

export const renderRssFeed = ({ site, items }) => {
	const prevHydration = getReframeHydrationEnabled()
	const prevThemeHydration = state.THEME_ENV?.getHydrationEnabled?.()
	setReframeHydrationEnabled(false)
	state.THEME_ENV?.setHydrationEnabled?.(false)
	try {
		return HTMLRenderer.serialize(HTMLRenderer.c(RssFeed, { site, items }))
	} finally {
		setReframeHydrationEnabled(prevHydration)
		if (prevThemeHydration != null) {
			state.THEME_ENV?.setHydrationEnabled?.(prevThemeHydration)
		}
	}
}

export const renderAtomFeed = ({ site, items }) => {
	const prevHydration = getReframeHydrationEnabled()
	const prevThemeHydration = state.THEME_ENV?.getHydrationEnabled?.()
	setReframeHydrationEnabled(false)
	state.THEME_ENV?.setHydrationEnabled?.(false)
	try {
		return HTMLRenderer.serialize(HTMLRenderer.c(AtomFeed, { site, items }))
	} finally {
		setReframeHydrationEnabled(prevHydration)
		if (prevThemeHydration != null) {
			state.THEME_ENV?.setHydrationEnabled?.(prevThemeHydration)
		}
	}
}

export const generateRssFeed = async (pagesContext, rssContent = null) => {
	if (!state.RSS_ENABLED) return null
	const options = state.RSS_OPTIONS || {}
	const site = pagesContext?.site || state.USER_SITE || {}
	const siteUrl = resolveSiteUrl(options, site)
	if (!isAbsoluteUrl(siteUrl)) {
		logger.warn('Feed skipped: site.base must be an absolute URL (e.g. https://example.com/).')
		return null
	}
	const isAtom = options.atom === true
	const path = normalizeFeedPath(options.path, isAtom)
	const limit =
		typeof options.limit === 'number' && Number.isFinite(options.limit)
			? Math.max(0, Math.floor(options.limit))
			: DEFAULT_RSS_LIMIT
	const now = new Date()
	const finalSite = {
		name: site.name,
		title: Object.prototype.hasOwnProperty.call(options, 'title') ? options.title : site.name,
		description: Object.prototype.hasOwnProperty.call(options, 'description') ? options.description : site.description,
		language: Object.prototype.hasOwnProperty.call(options, 'language') ? options.language : (site.language || site.lang),
		url: siteUrl,
		feedUrl: new URL(path, siteUrl).href,
		generator: 'Methanol',
		lastBuildDate: now.toUTCString(),
		updated: now.toISOString()
	}
	const items = (pagesContext?.pages || [])
		.map((page, index) => ({
			page,
			content: rssContent?.get(index) || null
		}))
		.filter((entry) => entry.page && !entry.page.hidden)
		.sort((a, b) => getSortTime(b.page) - getSortTime(a.page))
		.map((entry) => buildItem(entry.page, siteUrl, entry.content, isAtom))
		.filter(Boolean)
		.slice(0, limit)
	const xml = isAtom
		? renderAtomFeed({ site: finalSite, items })
		: renderRssFeed({ site: finalSite, items })
	const outPath = resolve(state.DIST_DIR, path.slice(1))
	await ensureDir(dirname(outPath))
	await writeFile(outPath, xml)
	logger.success(`${isAtom ? 'Atom' : 'RSS'} feed generated: ${path} (${items.length} ${items.length === 1 ? 'item' : 'items'})`)
	return { path, count: items.length }
}
