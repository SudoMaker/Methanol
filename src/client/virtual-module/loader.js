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

export function init(registry, R) {
	if (!registry) return

	async function $$rfrm(key, id, props, target = document.currentScript) {
		const loader = registry[key]

		if (!loader) {
			target.remove()
			return
		}

		const renderer = (await loader()).default

		if (!renderer) {
			if (process.env.NODE_ENV !== 'production') {
				throw new Error(`[REWiND] Hydration failed! Component '${key}' does not export \`default\`!`)
			}

			return
		}

		const findRewindAnchor = (node, token) => {
			const marker = `{${token}}`
			let current = node
			while (current) {
				let cursor = current.previousSibling
				while (cursor) {
					if (cursor.nodeType === 8 && cursor.nodeValue === marker) {
						return cursor
					}
					cursor = cursor.previousSibling
				}
				current = current.parentNode
			}
			return null
		}

		const collectChildren = (fragment, token) => {
			const startMarker = `[${token}[`
			const endMarker = `]${token}]`
			const walker = document.createTreeWalker(
				fragment,
				NodeFilter.SHOW_COMMENT,
				null,
			)
			let start = null
			let end = null
			while (walker.nextNode()) {
				const value = walker.currentNode.nodeValue
				if (!start && value === startMarker) {
					start = walker.currentNode
					continue
				}
				if (start && value === endMarker) {
					end = walker.currentNode
					break
				}
			}
			if (!start || !end) return []
			const range = document.createRange()
			range.setStartAfter(start)
			range.setEndBefore(end)
			const childrenFragment = range.extractContents()
			return Array.from(childrenFragment.childNodes)
		}

		const idStr = id.toString(16)

		const anchor = findRewindAnchor(target, idStr)
		if (!anchor || !anchor.parentNode) {
			target.replaceWith(R.c(renderer, props))
			return
		}

		const range = document.createRange()
		range.setStartAfter(anchor)
		range.setEndBefore(target)
		const between = range.extractContents()
		const children = collectChildren(between, idStr)
		const rendered = R.c(renderer, props, ...children)
		target.replaceWith(rendered)
		anchor.remove()
	}

	let loaded = []
	if (window.$$rfrm) {
		loaded = window.$$rfrm.$$loaded
	}
	window.$$rfrm = $$rfrm

	if (loaded) {
		for (let i = 0; i < loaded.length; i++) {
			$$rfrm.apply(null, loaded[i])
		}
	}
}
