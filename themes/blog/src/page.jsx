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

import { DOCTYPE_HTML } from 'methanol'
import { LayoutHome } from './layout-home.jsx'
import { LayoutCategories } from './layout-categories.jsx'
import { LayoutCollections } from './layout-collections.jsx'
import { LayoutPost } from './layout-post.jsx'

const Header = ({ siteName, navLinks, components, pagefindOptions }) => {
	const { ThemeSearchBox } = components || {}
	return (
		<header class="blog-header">
			<div class="container header-container">
				<a href="/" class="blog-logo">
					{siteName}
				</a>
				<div class="header-actions">
					{ThemeSearchBox && <ThemeSearchBox options={pagefindOptions} />}
					
					<input type="checkbox" id="nav-toggle" class="nav-toggle" />
					<label for="nav-toggle" class="nav-toggle-label">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="3" y1="12" x2="21" y2="12"></line>
							<line x1="3" y1="6" x2="21" y2="6"></line>
							<line x1="3" y1="18" x2="21" y2="18"></line>
						</svg>
					</label>

					<nav class="blog-nav">
						{navLinks.map((link, i) => (
							<a key={i} href={link.href}>
								{link.label}
							</a>
						))}
					</nav>
				</div>
			</div>
		</header>
	)
}

const Footer = ({ siteName }) => (
	<footer class="blog-footer">
		<div class="container">
			<p>
				&copy; {new Date().getFullYear()} {siteName}. Powered by <a href="https://methanol.sudoMaker.com">Methanol</a>.
			</p>
		</div>
	</footer>
)

const PAGE_TEMPLATE = ({ PageContent, ExtraHead, components, ctx, withBase }) => {
	const page = ctx.page
	const siteName = ctx.site.name || 'Methanol Blog'
	const title = page.title || siteName

	const isHome = page.routePath === '/'

	const navLinks = page.frontmatter?.navLinks ||
		ctx.pagesByRoute.get('/')?.frontmatter?.navLinks ||
		ctx.site.navLinks || [
			{ label: 'Home', href: '/' },
			{ label: 'About', href: '/about' },
			{ label: 'Categories', href: '/categories' },
			{ label: 'Collections', href: '/collections' }
		]
	const resolvedNavLinks = navLinks.map((link) => {
		const href = link?.href
		if (typeof href === 'string' && href.startsWith('/')) {
			return { ...link, href: withBase(href) }
		}
		return link
	})

	const isCategoriesPage = page.routePath === '/categories'
	const isCollectionsPage = page.routePath === '/collections'

	const pagefindEnabled = ctx.site.pagefind?.enabled !== false
	const pagefindOptions = ctx.site.pagefind?.options || null

	return (
		<>
			{DOCTYPE_HTML}
			<html lang="en">
				<head>
					<meta charset="UTF-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1.0" />
					<title>
						{title} | {siteName}
					</title>
					<link rel="stylesheet" href="/.methanol_theme_blog/style.css" />
					<ExtraHead />
				</head>
				<body>
					<div class="layout">
						<Header
							siteName={siteName}
							navLinks={resolvedNavLinks}
							components={pagefindEnabled ? components : {}}
							pagefindOptions={pagefindOptions}
						/>
						<main class="container main-content">
							{isHome ? (
								<LayoutHome PageContent={PageContent} pages={ctx.pages} navLinks={navLinks} components={components} />
							) : isCategoriesPage ? (
								<LayoutCategories
									PageContent={PageContent}
									title={title}
									pages={ctx.pages}
									navLinks={navLinks}
									components={components}
								/>
							) : isCollectionsPage ? (
								<LayoutCollections
									PageContent={PageContent}
									title={title}
									pages={ctx.pages}
									pagesByRoute={ctx.pagesByRoute}
									navLinks={navLinks}
									components={components}
								/>
							) : (
								<LayoutPost PageContent={PageContent} title={title} page={page} />
							)}
						</main>
						<Footer siteName={siteName} />
					</div>
				</body>
			</html>
		</>
	)
}

export default PAGE_TEMPLATE
