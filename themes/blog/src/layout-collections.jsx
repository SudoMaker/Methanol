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

import { filterBlogPosts, mapStaticPosts, collectCollectionTitles } from './post-utils.js'
import { formatDate } from '../src/date-utils.js'

const renderPostCards = (posts = [], collectionTitles = {}) =>
	posts.map((p) => {
		const dateStr = formatDate(p.frontmatter?.date || p.stats?.createdAt)
		const collectionLabel = p.collection ? collectionTitles?.[p.collection] || p.collection : ''
		return (
			<article class="post-item">
				<div class="post-meta">
					{dateStr && <span class="post-date">{dateStr}</span>}
					{collectionLabel && <span class="post-categories"> &middot; {collectionLabel}</span>}
				</div>
				<h2 class="post-item-title">
					<a href={p.routeHref}>{p.title || 'Untitled'}</a>
				</h2>
				<div class="post-excerpt">{p.excerpt || p.frontmatter?.excerpt || 'No excerpt available.'}</div>
			</article>
		)
	})

export const LayoutCollections = ({ PageContent, title, pages, pagesByRoute, navLinks, components }) => {
	const { CollectionView } = components || {}
	const filteredPosts = filterBlogPosts(pages, navLinks)
	const staticPosts = mapStaticPosts(filteredPosts)
	const collectionTitles = collectCollectionTitles(staticPosts, pagesByRoute)
	const visiblePosts = staticPosts.slice(0, 10)
	const staticCards = renderPostCards(visiblePosts, collectionTitles)
	return (
		<div class="categories-container">
			<header class="post-header">
				<h1 class="post-title">{title}</h1>
			</header>
			<div class="categories-content">
				<PageContent />
				{CollectionView ? (
					<CollectionView collectionTitles={collectionTitles}>{...staticCards}</CollectionView>
				) : (
					<p>Error: CollectionView component not found.</p>
				)}
			</div>
		</div>
	)
}
