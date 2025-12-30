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

import { signal, $, t, If, For, onCondition } from 'refui'
import { createPortal } from 'refui/extras'
import { loadPagefind } from '/.methanol_virtual_module/pagefind.js'

let keybindReady = false
let cachedPagefind = null

const resolveShortcutLabel = () => {
	if (typeof navigator === 'undefined') return 'Ctrl+K'
	const platform = navigator.platform || ''
	const agent = navigator.userAgent || ''
	const isMac = /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(agent)
	return isMac ? '⌘K' : 'Ctrl+K'
}

const ensurePagefind = async (options) => {
	if (cachedPagefind) return cachedPagefind
	const pagefind = await loadPagefind()
	if (!pagefind) return null
	if (pagefind.options) {
		const nextOptions = { excerptLength: 30, ...(options || {}) }
		await pagefind.options(nextOptions)
	}
	if (pagefind.init) {
		await pagefind.init()
	}
	cachedPagefind = pagefind
	return pagefind
}

export default function ({ options } = {}) {
	const isOpen = signal(false)
	const query = signal('')
	const results = signal([])
	const isLoading = signal(false)
	const activeIndex = signal(-1)

	const buttonRef = signal()
	const inputRef = signal()
	const resultIdPrefix = `search-result-${Math.random().toString(36).slice(2)}`
	const activeMatch = onCondition(activeIndex)

	let debounceTimer = null
	const shortcutLabel = resolveShortcutLabel()
	const [Inlet, Outlet] = createPortal()

	const search = async (q) => {
		isLoading.value = true
		results.value = []
		activeIndex.value = -1

		const pagefind = await ensurePagefind(options)
		if (!pagefind) {
			isLoading.value = false
			return
		}

		try {
			const searchResult = await pagefind.search(q)
			if (searchResult?.results?.length) {
				const data = await Promise.all(searchResult.results.slice(0, 10).map((r) => r.data()))
				results.value = data.map((value) => ({ value, el: signal() }))
			}
		} catch (err) {
			console.error('Search error:', err)
		} finally {
			isLoading.value = false
		}
	}

	const onInput = (event) => {
		const value = event.target.value
		query.value = value
		if (debounceTimer) clearTimeout(debounceTimer)

		if (!value.trim()) {
			results.value = []
			activeIndex.value = -1
			return
		}

		debounceTimer = setTimeout(() => {
			search(value)
		}, 300)
	}

	const focusInput = () => {
		if (inputRef.value) inputRef.value.focus()
	}

	const open = async () => {
		isOpen.value = true
		setTimeout(focusInput, 50)
		await ensurePagefind(options)
	}

	const close = () => {
		isOpen.value = false
		query.value = ''
		results.value = []
		activeIndex.value = -1
		if (debounceTimer) clearTimeout(debounceTimer)
		if (inputRef.value) inputRef.value.blur()
		if (buttonRef.value) buttonRef.value.focus()
	}

	const scrollActiveIntoView = () => {
		setTimeout(() => {
			const activeEl = results.value[activeIndex.value]?.el.value
			if (activeEl) {
				activeEl.scrollIntoView({ block: 'nearest' })
			}
		}, 0)
	}

	const onKeyDown = (event) => {
		if (event.key === 'Escape') {
			event.preventDefault()
			close()
			return
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault()
			if (results.value.length > 0) {
				const nextIndex = activeIndex.value >= 0 ? (activeIndex.value + 1) % results.value.length : 0
				activeIndex.value = nextIndex
				scrollActiveIntoView()
			}
		} else if (event.key === 'ArrowUp') {
			event.preventDefault()
			if (results.value.length > 0) {
				const nextIndex = activeIndex.value > 0 ? activeIndex.value - 1 : results.value.length - 1
				activeIndex.value = nextIndex
				scrollActiveIntoView()
			}
		} else if (event.key === 'Enter') {
			event.preventDefault()
			const selected = results.value[activeIndex.value]?.value
			const fallback = results.value[0]?.value
			const target = selected || fallback
			if (target?.url) {
				window.location.href = target.url
				close()
			}
		}
	}

	const onResultKeyDown = (event, indexValue) => {
		if (event.key === 'Escape') {
			event.preventDefault()
			close()
			return
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault()
			const nextIndex = (indexValue + 1) % results.value.length
			activeIndex.value = nextIndex
			scrollActiveIntoView()
		} else if (event.key === 'ArrowUp') {
			event.preventDefault()
			if (indexValue === 0) {
				activeIndex.value = -1
				focusInput()
				return
			}
			const nextIndex = indexValue - 1
			activeIndex.value = nextIndex
			scrollActiveIntoView()
		}
	}

	const showEmpty = $(() => !query.value)
	const showNoResults = $(() => {
		const _query = query.value
		const _isLoading = isLoading.value
		const _length = results.value.length
		return _query && !_isLoading && _length === 0
	})

	if (typeof window !== 'undefined') {
		window.__methanolSearchOpen = open
		window.__methanolSearchClose = close
	}

	if (typeof window !== 'undefined' && !keybindReady) {
		keybindReady = true
		window.addEventListener('keydown', (event) => {
			const key = event.key?.toLowerCase?.()
			if ((event.metaKey || event.ctrlKey) && key === 'k') {
				event.preventDefault()
				if (isOpen.value) {
					close()
				} else {
					open()
				}
			} else if (key === 'escape' && isOpen.value) {
				close()
			}
		})
	}

	return (R) => {
		R.render(document.body, Outlet)
		return (
			<button class="search-box" type="button" on:click={open} attr:aria-label="Open search" $ref={buttonRef}>
				<svg
					attr:width="16"
					attr:height="16"
					attr:viewBox="0 0 24 24"
					attr:fill="none"
					attr:stroke="currentColor"
					attr:stroke-width="2"
					attr:stroke-linecap="round"
					attr:stroke-linejoin="round"
				>
					<circle attr:cx="11" attr:cy="11" attr:r="8"></circle>
					<path attr:d="m21 21-4.3-4.3"></path>
				</svg>
				<span>Search</span>
				<kbd>{shortcutLabel}</kbd>
				<Inlet>
					<div class="search-modal" class:open={isOpen} attr:inert={$(() => (isOpen.value ? null : ''))}>
						<div class="search-modal__scrim" on:click={close}></div>
						<div class="search-modal__panel">
							<div class="search-input-wrapper">
								<svg
									attr:width="20"
									attr:height="20"
									attr:viewBox="0 0 24 24"
									attr:fill="none"
									attr:stroke="currentColor"
									attr:stroke-width="2"
									attr:stroke-linecap="round"
									attr:stroke-linejoin="round"
								>
									<circle attr:cx="11" attr:cy="11" attr:r="8"></circle>
									<path attr:d="m21 21-4.3-4.3"></path>
								</svg>
								<input
									class="search-input"
									type="text"
									placeholder="Search documentation..."
									value={query}
									on:input={onInput}
									on:keydown={onKeyDown}
									attr:aria-activedescendant={$(() =>
										activeIndex.value >= 0 ? `${resultIdPrefix}-${activeIndex.value}` : null
									)}
									attr:autocomplete="off"
									attr:autocorrect="off"
									attr:spellcheck="false"
									$ref={inputRef}
								/>
							</div>
							<div class="search-results">
								<If condition={showEmpty}>{() => <div class="search-status">Type to start searching...</div>}</If>
								<If condition={showNoResults}>
									{() => <div class="search-status">No results found for "{query}"</div>}
								</If>
								<If condition={isLoading}>{() => <div class="search-status">Searching...</div>}</If>
								<For entries={results} indexed>
									{({ item: { value, el }, index }) => (
										<a
											class="search-result-item"
											class:active={activeMatch(index)}
											href={value.url}
											on:click={close}
											on:keydown={(event) => onResultKeyDown(event, index.value)}
											on:focus={() => {
												activeIndex.value = index.value
											}}
											attr:aria-selected={$(() => (activeIndex.value === index.value ? 'true' : 'false'))}
											attr:id={t`${resultIdPrefix}-${index.value}`}
											$ref={el}
										>
											<div class="search-result-title">
												<svg
													attr:width="14"
													attr:height="14"
													attr:viewBox="0 0 24 24"
													attr:fill="none"
													attr:stroke="currentColor"
													attr:stroke-width="2"
													attr:stroke-linecap="round"
													attr:stroke-linejoin="round"
												>
													<path attr:d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
													<polyline attr:points="14 2 14 8 20 8"></polyline>
												</svg>
												{value?.meta?.title || value?.title || value?.url}
											</div>
											<div class="search-result-excerpt" innerHTML={value.excerpt || ''}></div>
										</a>
									)}
								</For>
							</div>
						</div>
					</div>
				</Inlet>
			</button>
		)
	}
}
