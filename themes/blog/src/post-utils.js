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

import { extractExcerpt } from 'methanol'

const isBlogPost = (page) => {
	if (!page || page.hidden || page.hiddenByParent) return false
	const href = page.routeHref
	if (!href) return false
	if (href === '/' || href === '/404' || href === '/offline') return false
	if (href.startsWith('/.methanol')) return false
	return true
}

export const filterBlogPosts = (pages, navLinks = [], options = {}) => {
	const excluded = new Set((navLinks || []).map((link) => link?.href).filter(Boolean))
	const list = (pages || []).filter((page) => isBlogPost(page) && !excluded.has(page.routeHref))
	const { currentRoutePath, hiddenPrefixes } = options || {}
	const activeRoute = typeof currentRoutePath === 'string' ? currentRoutePath : ''
	const hiddenScopes = Array.isArray(hiddenPrefixes) ? hiddenPrefixes.filter(Boolean) : []
	const filtered = hiddenScopes.length
		? list.filter((page) => {
				const hiddenScope = hiddenScopes.find((prefix) => page.routePath?.startsWith(prefix))
				if (!hiddenScope) return true
				return activeRoute.startsWith(hiddenScope)
			})
		: list
	filtered.sort((a, b) => {
		const dateA = new Date(a.frontmatter?.date || a.stats?.createdAt || 0)
		const dateB = new Date(b.frontmatter?.date || b.stats?.createdAt || 0)
		return dateB - dateA
	})
	return filtered
}

export const getExcerpt = (page) => extractExcerpt(page)

export const getCollection = (page) => {
	if (!page?.dir) return null
	return page.dir.split('/')[0]
}

export const mapStaticPosts = (posts = []) =>
	posts.map((page) => ({
		title: page.title,
		routeHref: page.routeHref,
		frontmatter: page.frontmatter || {},
		stats: page.stats || {},
		excerpt: getExcerpt(page),
		collection: getCollection(page)
	}))

export const collectCategories = (posts = []) =>
	Array.from(
		new Set(
			posts.flatMap((page) => {
				const c = page.frontmatter?.categories
				return Array.isArray(c) ? c : c ? [c] : []
			})
		)
	).sort()

export const collectCollectionTitles = (posts = [], pagesByRoute = new Map()) => {
	const collectionTitles = {}
	for (const collection of new Set(posts.map((p) => p.collection).filter(Boolean))) {
		const routePath = `/${collection}/`
		const entry = pagesByRoute?.get?.(routePath) || pagesByRoute?.get?.(`/${collection}`) || null
		collectionTitles[collection] = entry?.title || collection
	}
	for (const key of Object.keys(collectionTitles).sort()) {
		if (!collectionTitles[key]) {
			collectionTitles[key] = key
		}
	}
	return collectionTitles
}
