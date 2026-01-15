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

import { HTMLRenderer as R } from 'methanol'
import { filterBlogPosts, mapStaticPosts, collectCategories } from './post-utils.js'
import { formatDate } from '../src/date-utils.js'

const renderPostCards = (posts = []) =>
	posts.map((p) => {
		const dateStr = formatDate(p.frontmatter?.date || p.stats?.createdAt)
		const categories = p.frontmatter?.categories
		const categoryLabel = Array.isArray(categories) ? categories.join(', ') : categories || ''
		return (
			<article class="post-item">
				<div class="post-meta">
					{dateStr && <span class="post-date">{dateStr}</span>}
					{categoryLabel && <span class="post-categories"> &middot; {categoryLabel}</span>}
				</div>
				<h2 class="post-item-title">
					<a href={p.routeHref}>{p.title || 'Untitled'}</a>
				</h2>
				<div class="post-excerpt">{p.excerpt || p.frontmatter?.excerpt || 'No excerpt available.'}</div>
			</article>
		)
	})

export const LayoutCategories = ({ PageContent, title, pages, navLinks, components }) => {
	const { CategoryView } = components || {}
	const filteredPosts = filterBlogPosts(pages, navLinks)
	const staticPosts = mapStaticPosts(filteredPosts)
	const categories = collectCategories(filteredPosts)
	const visiblePosts = staticPosts.slice(0, 10)
	const staticCards = renderPostCards(visiblePosts)
	return (
		<div class="categories-container">
			<header class="post-header">
				<h1 class="post-title">{title}</h1>
			</header>
			<div class="categories-content">
				<PageContent />
				{CategoryView ? (
					<CategoryView categories={categories}>{...staticCards}</CategoryView>
				) : (
					<p>Error: CategoryView component not found.</p>
				)}
			</div>
		</div>
	)
}
