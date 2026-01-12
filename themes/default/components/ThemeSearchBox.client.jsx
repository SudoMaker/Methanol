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

let pagefindModule = null
const loadPagefindModule = async () => {
	if (pagefindModule) return pagefindModule
	pagefindModule = import('methanol:pagefind-loader')
	return pagefindModule
}

let keybindReady = false
let cachedPagefind = null
const PAGE_SIZE = 10

const resolveShortcutLabel = () => {
	if (typeof navigator === 'undefined') return 'Ctrl+K'
	const platform = navigator.platform || ''
	const agent = navigator.userAgent || ''
	const isMac = /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(agent)
	return isMac ? '⌘K' : 'Ctrl+K'
}

const ensurePagefind = async (options) => {
	if (cachedPagefind) return cachedPagefind
	const module = await loadPagefindModule()
	const pagefind = await module?.loadPagefind?.()
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
	const isLoadingMore = signal(false)
	const hasMore = signal(false)
	const activeIndex = signal(-1)
	const loadError = signal('')

	const buttonRef = signal()
	const inputRef = signal()
	const resultsRef = signal()
	const loadingMoreRef = signal()
	const resultIdPrefix = `search-result-${Math.random().toString(36).slice(2)}`
	const activeMatch = onCondition(activeIndex)

	let debounceTimer = null
	let resultHandles = []
	let resultOffset = 0
	let latestSearchId = 0
	const shortcutLabel = resolveShortcutLabel()
	const [Inlet, Outlet] = createPortal()

	const resetSearchState = () => {
		resultHandles = []
		resultOffset = 0
		hasMore.value = false
		isLoadingMore.value = false
	}

	const loadMore = async (initial = false) => {
		const searchId = latestSearchId
		if (!initial) {
			if (isLoadingMore.value || !hasMore.value) return
			isLoadingMore.value = true
		}

		const slice = resultHandles.slice(resultOffset, resultOffset + PAGE_SIZE)
		if (!slice.length) {
			hasMore.value = false
			if (!initial) isLoadingMore.value = false
			return
		}

		try {
			const data = await Promise.all(slice.map((r) => r.data()))
			if (searchId !== latestSearchId) return

			results.value = results.value.concat(data.map((value) => ({ value, el: signal() })))
			resultOffset += slice.length
			hasMore.value = resultOffset < resultHandles.length
		} catch (err) {
			if (searchId !== latestSearchId) return
			loadError.value = 'Search is unavailable. Please refresh and try again.'
			console.error('Search error:', err)
		} finally {
			if (!initial && searchId === latestSearchId) isLoadingMore.value = false
		}
	}

	const search = async (q) => {
		const searchId = ++latestSearchId
		isLoading.value = true
		results.value = []
		activeIndex.value = -1
		resetSearchState()

		const pagefind = await ensurePagefind(options)
		if (searchId !== latestSearchId) return

		if (!pagefind) {
			isLoading.value = false
			loadError.value = 'Search is unavailable. Please refresh and try again.'
			return
		}
		loadError.value = ''

		try {
			const searchResult = await pagefind.search(q)
			if (searchId !== latestSearchId) return

			resultHandles = searchResult?.results || []
			resultOffset = 0
			hasMore.value = resultHandles.length > 0
			await loadMore(true)
		} catch (err) {
			if (searchId !== latestSearchId) return
			loadError.value = 'Search is unavailable. Please refresh and try again.'
			console.error('Search error:', err)
		} finally {
			if (searchId === latestSearchId) isLoading.value = false
		}
	}

	const onInput = (event) => {
		const value = event.target.value
		query.value = value
		loadError.value = ''
		if (debounceTimer) clearTimeout(debounceTimer)

		if (!value.trim()) {
			latestSearchId++
			isLoading.value = false
			results.value = []
			resetSearchState()
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
		const pagefind = await ensurePagefind(options)
		if (!pagefind) {
			loadError.value = 'Search is unavailable. Please refresh and try again.'
		}
	}

	const close = () => {
		isOpen.value = false
		query.value = ''
		results.value = []
		loadError.value = ''
		resetSearchState()
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
				if (hasMore.value && activeIndex.value === results.value.length - 1) {
					loadMore(false)
					setTimeout(() => {
						loadingMoreRef.value?.scrollIntoView({ block: 'nearest' })
					}, 10)
					return
				}
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
			if (hasMore.value && indexValue === results.value.length - 1) {
				loadMore(false)
				setTimeout(() => {
					loadingMoreRef.value?.scrollIntoView({ block: 'nearest' })
				}, 10)
				return
			}
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

	const onResultsScroll = (event) => {
		const el = event.currentTarget
		if (!el) return
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
		if (nearBottom) loadMore(false)
	}

	const showEmpty = $(() => !query.value)
	const showNoResults = $(() => {
		const _query = query.value
		const _isLoading = isLoading.value
		const _length = results.value.length
		return _query && !_isLoading && _length === 0
	})
	const showError = $(() => loadError.value)
	const showStatus = $(() => !loadError.value)
	const showLoadingMore = $(() => isLoadingMore.value && !isLoading.value)

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
							<div class="search-results" on:scroll={onResultsScroll} $ref={resultsRef}>
								<If condition={showError}>{() => <div class="search-status">{loadError}</div>}</If>
								<If condition={showStatus}>
									{() => (
										<>
											<If condition={showEmpty}>{() => <div class="search-status">Type to start searching...</div>}</If>
											<If condition={showNoResults}>
												{() => <div class="search-status">No results found for "{query}"</div>}
											</If>
											<If condition={isLoading}>{() => <div class="search-status">Searching...</div>}</If>
										</>
									)}
								</If>
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
								<If condition={showLoadingMore}>
									{() => (
										<div
											class="search-status"
											$ref={(el) => {
												loadingMoreRef.value = el
												el.scrollIntoView({ block: 'nearest' })
											}}
										>
											Loading more results...
										</div>
									)}
								</If>{' '}
							</div>
						</div>
					</div>
				</Inlet>
			</button>
		)
	}
}
