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

import { signal, $, For, If, onCondition } from 'refui'
import pages from 'methanol:pages'
import { formatDate } from '../src/date-utils.js'

const rawPages = Array.isArray(pages) ? pages : []
const isPostPage = (p) => {
	if (!p?.routeHref) return false
	if (p.routeHref === '/' || p.routeHref === '/404' || p.routeHref === '/offline') return false
	if (p.routeHref.startsWith('/.methanol')) return false
	return true
}
const resolvePosts = () => {
	const list = rawPages.filter(isPostPage)
	list.sort((a, b) => {
		const dateA = new Date(a.frontmatter?.date || a.stats?.createdAt || 0)
		const dateB = new Date(b.frontmatter?.date || b.stats?.createdAt || 0)
		return dateB - dateA
	})
	return list.map((p) => ({
		title: p.title,
		routeHref: p.routeHref,
		frontmatter: p.frontmatter || {},
		stats: p.stats || {},
		excerpt: p.excerpt || p.frontmatter?.excerpt || ''
	}))
}
const allPosts = resolvePosts()
const defaultCategories = Array.from(
	new Set(
		allPosts.flatMap((p) => {
			const c = p.frontmatter?.categories
			return Array.isArray(c) ? c : c ? [c] : []
		})
	)
).sort()

export default function ({ categories = null } = {}) {
	const currentCategory = signal('')
	const activeCategory = onCondition(currentCategory)
	const visibleCount = signal(10)
	const categoryList = Array.isArray(categories) && categories.length ? categories : defaultCategories

	if (typeof window !== 'undefined') {
		// Initial setup on client side
		const params = new URLSearchParams(window.location.search)
		const cat = params.get('category')
		if (cat) currentCategory.value = cat

		window.addEventListener('popstate', () => {
			const p = new URLSearchParams(window.location.search)
			currentCategory.value = p.get('category') || ''
		})
	}

	const filteredPosts = $(() => {
		const cat = currentCategory.value
		if (!cat) return allPosts
		return allPosts.filter((p) => {
			const pCats = p.frontmatter?.categories || []
			return Array.isArray(pCats) ? pCats.includes(cat) : pCats === cat
		})
	})

	const visiblePosts = $(() => filteredPosts.value.slice(0, visibleCount.value))
	const hasMore = $(() => visibleCount.value < filteredPosts.value.length)
	const showEmpty = $(() => filteredPosts.value.length === 0)

	const loadMore = () => {
		visibleCount.value += 10
	}

	const setCategory = (cat) => {
		currentCategory.value = cat
		visibleCount.value = 10
		const url = new URL(window.location)
		if (cat) {
			url.searchParams.set('category', cat)
		} else {
			url.searchParams.delete('category')
		}
		window.history.pushState({}, '', url)
	}

	return (
		<div class="category-view">
			<div class="category-list">
				<button class="category-tag" class:active={activeCategory('')} on:click={() => setCategory('')}>
					All
				</button>
				<For entries={categoryList}>
					{({ item: cat }) => (
						<button
							class="category-tag"
							class:active={activeCategory(cat.value)}
							on:click={() => setCategory(cat.value)}
						>
							{cat}
						</button>
					)}
				</For>
			</div>

			<div class="post-list">
				<For entries={visiblePosts}>
					{({ item: p }) => {
						const dateStr = formatDate(p.frontmatter?.date || p.stats?.createdAt)

						return (
							<article class="post-item">
								<div class="post-meta">
									{dateStr && <span class="post-date">{dateStr}</span>}
									{p.frontmatter.categories && (
										<span class="post-categories">
											&middot;{' '}
											{Array.isArray(p.frontmatter.categories)
												? p.frontmatter.categories.join(', ')
												: p.frontmatter.categories}
										</span>
									)}
								</div>
								<h2 class="post-item-title">
									<a href={p.routeHref}>{p.title || 'Untitled'}</a>
								</h2>
								<div class="post-excerpt">{p.frontmatter.excerpt || p.excerpt || 'No excerpt available.'}</div>
							</article>
						)
					}}
				</For>
			</div>

			<If condition={showEmpty}>{() => <p>No posts found in this category.</p>}</If>

			<If condition={hasMore}>
				{() => (
					<div class="pagination-container">
						<button class="load-more-btn" on:click={loadMore}>
							Load More
						</button>
					</div>
				)}
			</If>
		</div>
	)
}
