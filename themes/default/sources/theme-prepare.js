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

;(function initThemeColor() {
	const savedTheme = localStorage.getItem('methanol-theme')
	const systemTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
	const theme = savedTheme || systemTheme
	document.documentElement.classList.toggle('light', theme === 'light')
	document.documentElement.classList.toggle('dark', theme === 'dark')

	const savedAccent = localStorage.getItem('methanol-accent')
	if (savedAccent && savedAccent !== 'default') {
		document.documentElement.classList.add('accent-' + savedAccent)
	}
})
;(function initPrefetch() {
	const prefetched = new Set()
	const canPrefetch = (anchor) => {
		if (!anchor || !anchor.href) return false
		if (anchor.dataset && anchor.dataset.prefetch === 'false') return false
		if (anchor.hasAttribute('download')) return false
		if (anchor.target && anchor.target !== '_self') return false
		const url = new URL(anchor.href, window.location.href)
		if (url.origin !== window.location.origin) return false
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
		if (url.pathname === window.location.pathname && url.search === window.location.search) {
			return false
		}
		return true
	}
	const onHover = (event) => {
		const anchor = event.target && event.target.closest ? event.target.closest('a') : null
		if (!canPrefetch(anchor)) return
		const href = anchor.href
		if (prefetched.has(href)) return
		prefetched.add(href)
		const link = document.createElement('link')
		link.rel = 'prefetch'
		link.as = 'document'
		link.href = href
		document.head.appendChild(link)
	}
	document.addEventListener('pointerover', onHover, { capture: true, passive: true })
})
