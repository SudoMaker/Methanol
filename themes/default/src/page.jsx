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
import { renderToc } from '../components/ThemeToCContainer.static.jsx'
import { renderNavTree } from './nav-tree.jsx'

const PAGE_TEMPLATE = ({ PageContent, ExtraHead, components, ctx }) => {
	const page = ctx.page
	const pagesByRoute = ctx.pagesByRoute
	const pages = ctx.pages || []
	const pagesTree = ctx.pagesTree || []
	const siteName = ctx.site.name || 'Methanol Site'
	const title = page.title || siteName
	const baseHref =
		page.routeHref === '/404' || page.routeHref === '/offline' ? ctx.site.base || '/' : null
	const toc = page.toc?.length ? renderToc(page.toc) : null
	const hasToc = Boolean(toc)
	const layoutClass = hasToc ? 'layout-container' : 'layout-container no-toc'
	const { ThemeSearchBox, ThemeColorSwitch, ThemeAccentSwitch, ThemeToCContainer } = components
	const rootPage = pagesByRoute.get('/') || pages.find((entry) => entry.routeHref === '/')
	const pageFrontmatter = page.frontmatter || {}
	const rootFrontmatter = rootPage.frontmatter || {}
	const themeLogo = '/logo.png'
	const themeFavIcon = '/favicon.png'
	const logo = pageFrontmatter.logo ?? rootFrontmatter.logo ?? ctx.site.logo ?? themeLogo
	const favicon = pageFrontmatter.favicon ?? rootFrontmatter.favicon ?? ctx.site.favicon ?? themeFavIcon
	const excerpt = pageFrontmatter.excerpt ?? `${title} | ${siteName} - Powered by Methanol`
	const _ogTitle = pageFrontmatter.ogTitle ?? title ?? null
	const ogTitle = _ogTitle ? `${_ogTitle} | ${siteName}` : null
	const ogDescription = pageFrontmatter.ogDescription ?? excerpt ?? null
	const ogImage = pageFrontmatter.ogImage ?? null
	const ogUrl = pageFrontmatter.ogUrl ?? null
	const twitterTitle = pageFrontmatter.twitterTitle ?? ogTitle
	const twitterDescription = pageFrontmatter.twitterDescription ?? ogDescription ?? excerpt
	const twitterImage = pageFrontmatter.twitterImage ?? ogImage
	const twitterCard = pageFrontmatter.twitterCard ?? (twitterImage ? 'summary_large_image' : null)
	const siblings = page.getSiblings()
	const prevPage = siblings?.prev || null
	const nextPage = siblings?.next || null
	const languages = Array.isArray(ctx.languages) ? ctx.languages : []
	const currentLanguageHref = ctx.language?.href || ctx.language?.routeHref || null
	const languageCode = pageFrontmatter.langCode ?? rootFrontmatter.langCode ?? ctx.language?.code ?? 'en'
	const htmlLang = typeof languageCode === 'string' && languageCode.trim() ? languageCode : 'en'
	const pagefindEnabled = ctx.site.pagefind?.enabled !== false
	const pagefindOptions = ctx.site.pagefind?.options || null
	const feedInfo = ctx.site.feed
	const rssHref = feedInfo?.enabled ? feedInfo.href : null
	const feedType = feedInfo?.atom ? 'application/atom+xml' : 'application/rss+xml'
	const feedLabel = feedInfo?.atom ? 'Atom' : 'RSS'
	const repoBase = ctx.site.repoBase
	const sourceUrl = pageFrontmatter.sourceURL
	const editUrl = sourceUrl || (repoBase && page.relativePath ? new URL(page.relativePath, repoBase).href : null)
	const languageSelector = languages.length ? (
		<div class="lang-switch-wrapper">
			<select
				class="lang-switch-select"
				aria-label="Select language"
				onchange="location.href=this.value"
				value={currentLanguageHref || undefined}
			>
				{languages.map((lang) => {
					const optionValue = lang.href || lang.routeHref
					const isSelected = optionValue && optionValue === currentLanguageHref
					return (
						<option value={optionValue} selected={isSelected ? true : null}>
							{lang.label}
						</option>
					)
				})}
			</select>
			<div class="lang-switch-icon">
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<circle cx="12" cy="12" r="10"></circle>
					<line x1="2" y1="12" x2="22" y2="12"></line>
					<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
				</svg>
			</div>
		</div>
	) : null

	return (
		<>
			{DOCTYPE_HTML}
			<html lang={htmlLang}>
				<head>
					<meta charset="UTF-8" />
					<meta name="viewport" content="width=device-width" />
					<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
					<meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)" />
					<title>
						{title} | {siteName}
					</title>
					{baseHref ? <base href={baseHref} /> : null}
					{favicon ? <link rel="icon" href={favicon} /> : null}
					<meta name="description" content={excerpt} />
					{ogTitle ? <meta property="og:title" content={ogTitle} /> : null}
					{ogDescription ? <meta property="og:description" content={ogDescription} /> : null}
					{ogImage ? <meta property="og:image" content={ogImage} /> : null}
					{ogUrl ? <meta property="og:url" content={ogUrl} /> : null}
					{twitterCard ? <meta name="twitter:card" content={twitterCard} /> : null}
					{twitterTitle ? <meta name="twitter:title" content={twitterTitle} /> : null}
					{twitterDescription ? <meta name="twitter:description" content={twitterDescription} /> : null}
					{twitterImage ? <meta name="twitter:image" content={twitterImage} /> : null}
					{rssHref ? <link rel="alternate" type={feedType} title={`${siteName} ${feedLabel}`} href={rssHref} /> : null}
					<link
						rel="preload stylesheet"
						as="style"
						href="/.methanol_theme_default/style.css"
					/>
					<script type="module" src="/.methanol_theme_default/theme-prepare.js"></script>
					<ExtraHead />
				</head>
				<body>
					<input type="checkbox" id="nav-toggle" class="nav-toggle" />
					<label class="nav-toggle-label" for="nav-toggle" aria-label="Toggle navigation">
						<svg
							width="24"
							height="24"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<line x1="3" y1="12" x2="21" y2="12"></line>
							<line x1="3" y1="6" x2="21" y2="6"></line>
							<line x1="3" y1="18" x2="21" y2="18"></line>
						</svg>
					</label>
					{pagefindEnabled ? (
						<button class="search-toggle-label" aria-label="Open search" onclick="window.__methanolSearchOpen()">
							<svg
								width="24"
								height="24"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<circle cx="11" cy="11" r="8"></circle>
								<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
							</svg>
						</button>
					) : null}
					{hasToc ? (
						<>
							<input type="checkbox" id="toc-toggle" class="toc-toggle" />
							<label class="toc-toggle-label" for="toc-toggle" aria-label="Toggle table of contents">
								<svg
									width="20"
									height="20"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
									<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
								</svg>
							</label>
						</>
					) : null}
					<label class="nav-scrim nav-scrim-nav" for="nav-toggle" aria-label="Close navigation"></label>
					{hasToc ? (
						<label class="nav-scrim nav-scrim-toc" for="toc-toggle" aria-label="Close table of contents"></label>
					) : null}
					<div class={layoutClass}>
						<aside class="sidebar">
							<div class="sidebar-header">
								<div class="logo">
									{logo ? <img src={logo} alt="logo" fetchpriority="high"/> : null}
									<span>{siteName}</span>
								</div>
								{pagefindEnabled ? <ThemeSearchBox options={pagefindOptions} /> : null}
							</div>
							<nav>
								<ul data-depth="0">{renderNavTree(pagesTree, page.routePath)}</ul>
							</nav>
							<div class="sidebar-footer">
								{languageSelector}
								<ThemeColorSwitch />
								<ThemeAccentSwitch />
								{rssHref ? (
									<a class="rss-link" href={rssHref} aria-label={feedLabel} title={feedLabel}>
										<svg
											width="18"
											height="18"
											viewBox="3 3 18 18"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<path d="M4 11a9 9 0 0 1 9 9"></path>
											<path d="M4 4a16 16 0 0 1 16 16"></path>
											<circle cx="5" cy="19" r="1"></circle>
										</svg>
									</a>
								) : null}
							</div>
						</aside>
						<main class="main-content" data-pagefind-body={pagefindEnabled ? '' : null}>
							<PageContent />
							{prevPage || nextPage ? (
								<nav class="page-nav">
									{prevPage ? (
										<a
											class="page-nav-card prev"
											href={prevPage.routeHref}
										>
											<span class="page-nav-label">Previous</span>
											<span class="page-nav-title">{prevPage.title || prevPage.routeHref}</span>
										</a>
									) : (
										<div class="page-nav-spacer"></div>
									)}
									{nextPage ? (
										<a
											class="page-nav-card next"
											href={nextPage.routeHref}
										>
											<span class="page-nav-label">Next</span>
											<span class="page-nav-title">{nextPage.title || nextPage.routeHref}</span>
										</a>
									) : null}
								</nav>
							) : null}
							{page ? (
								<footer class="page-meta">
									<div class="page-meta-item">
										{editUrl ? (
											<>
												<a
													href={editUrl}
													target="_blank"
													rel="noopener noreferrer"
													class="page-meta-link"
												>
													Edit this page
												</a>
												<span style="margin: 0 0.5rem; opacity: 0.5;">•</span>
											</>
										) : null}
										Updated: {page.stats.updatedAt || '-'}
									</div>
									<div class="page-meta-item">
										Powered by{' '}
										<a
											href="https://methanol.sudoMaker.com"
											target="_blank"
											rel="noopener noreferrer"
											class="methanol-link"
										>
											Methanol
										</a>
									</div>
								</footer>
							) : null}
						</main>
						{hasToc ? <ThemeToCContainer>{...toc}</ThemeToCContainer> : null}
					</div>
				</body>
			</html>
		</>
	)
}

export default PAGE_TEMPLATE
