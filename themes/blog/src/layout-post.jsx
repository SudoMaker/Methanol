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

export const LayoutPost = ({ PageContent, title, page }) => {
	return (
		<article class="post-content">
			<header class="post-header">
				{page.frontmatter.date && <div class="post-meta">{new Date(page.frontmatter.date).toLocaleDateString()}</div>}
				<h1 class="post-title">{title}</h1>
				{page.frontmatter.categories && (
					<div class="post-meta">
						{Array.isArray(page.frontmatter.categories)
							? page.frontmatter.categories.join(', ')
							: page.frontmatter.categories}
					</div>
				)}
			</header>
			<div class="post-body">
				<PageContent />
			</div>
		</article>
	)
}
