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

import { signal, t, useEffect } from 'refui'

export default function (props, ...children) {
	if (!children.length) {
		return
	}

	const el = signal()
	const top = signal(0)
	const height = signal(0)
	const opacity = signal(0)

	const updateActive = () => {
		if (!el.value) return

		const links = Array.from(el.value.querySelectorAll('a'))
		if (!links.length) return

		// Map links to their corresponding content anchors
		const anchors = links
			.map((link) => {
				const href = link.getAttribute('href')
				if (!href || !href.startsWith('#')) return null
				return document.getElementById(href.slice(1))
			})
			.filter(Boolean)

		if (!anchors.length) return

		const scrollY = window.scrollY
		const offset = 100 // Header offset

		// Find all sections that are visible in the viewport
		const visibleAnchors = new Set()
		const windowHeight = window.innerHeight
		const threshold = 100 // Header offset/buffer

		for (let i = 0; i < anchors.length; i++) {
			const anchor = anchors[i]
			const nextAnchor = anchors[i + 1]

			const sectionStart = anchor.offsetTop - threshold
			const sectionEnd = nextAnchor ? nextAnchor.offsetTop - threshold : document.body.offsetHeight

			// A section is visible if its range overlaps with the viewport [scrollY, scrollY + windowHeight]
			const isVisible = sectionStart < scrollY + windowHeight - threshold && sectionEnd > scrollY

			if (isVisible) {
				visibleAnchors.add(anchor)
			}
		}

		// Fallback: if somehow nothing is found, at least highlight the first one
		if (visibleAnchors.size === 0 && anchors.length > 0) {
			visibleAnchors.add(anchors[0])
		}

		// Update active class on links and find active range
		let firstActiveLink = null
		let lastActiveLink = null

		links.forEach((l) => {
			const href = l.getAttribute('href')
			const anchorId = href ? href.slice(1) : null
			const anchor = anchors.find((a) => a.id === anchorId)
			if (visibleAnchors.has(anchor)) {
				l.classList.add('active')
				if (!firstActiveLink) firstActiveLink = l
				lastActiveLink = l
			} else {
				l.classList.remove('active')
			}
		})

		// Update indicator position
		if (firstActiveLink && lastActiveLink) {
			const containerRect = el.value.getBoundingClientRect()
			const firstRect = firstActiveLink.getBoundingClientRect()
			const lastRect = lastActiveLink.getBoundingClientRect()

			const currentTop = firstRect.top - containerRect.top + el.value.scrollTop
			const currentHeight = lastRect.bottom - firstRect.top

			top.value = currentTop
			height.value = currentHeight
			opacity.value = 1

			// Scroll into view logic
			const indicatorTop = currentTop
			const indicatorBottom = currentTop + currentHeight
			const scrollTop = el.value.scrollTop
			const clientHeight = el.value.clientHeight

			if (indicatorTop < scrollTop + 20) {
				el.value.scrollTo({ top: indicatorTop - 20, behavior: 'smooth' })
			} else if (indicatorBottom > scrollTop + clientHeight - 20) {
				el.value.scrollTo({ top: indicatorBottom - clientHeight + 20, behavior: 'smooth' })
			}
		} else {
			opacity.value = 0
		}
	}

	// Attach listeners
	let ticking = false
	const onScroll = () => {
		if (!ticking) {
			window.requestAnimationFrame(() => {
				updateActive()
				ticking = false
			})
			ticking = true
		}
	}

	// Wait for mount/layout
	useEffect(() => {
		updateActive()
		window.addEventListener('scroll', onScroll, { passive: true })
		window.addEventListener('resize', onScroll, { passive: true })
		return () => {
			window.removeEventListener('scroll', onScroll)
			window.removeEventListener('resize', onScroll)
		}
	})

	return (
		<aside class="toc-panel" $ref={el}>
			<div
				class="toc-indicator"
				style:top={t`${top}px`}
				style:height={t`${height}px`}
				style:opacity={t`${opacity}`}
			></div>
			<div class="toc">
				<div class="toc-heading">On this page</div>
				<ul>{...children}</ul>
			</div>
		</aside>
	)
}
