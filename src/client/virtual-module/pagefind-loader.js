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

let pagefindInit = null
let pagefindUiInit = null
let pagefindUiReady = false

const resolveBasePrefix = () => {
	let base = import.meta.env?.BASE_URL || '/'
	if (!base || base === '/' || base === './') return ''
	if (base.startsWith('http://') || base.startsWith('https://')) {
		try {
			base = new URL(base).pathname
		} catch {
			return ''
		}
	}
	if (!base.startsWith('/')) return ''
	if (base.endsWith('/')) base = base.slice(0, -1)
	return base
}

const withBase = (path) => {
	const prefix = resolveBasePrefix()
	if (!prefix || path.startsWith(`${prefix}/`)) return path
	return `${prefix}${path}`
}

const dynamicImport = (path) => {
	try {
		const importer = new Function('p', 'return import(p)')
		return importer(path)
	} catch {
		return import(/* @vite-ignore */path)
	}
}

export const loadPagefind = () => {
	if (pagefindInit) return pagefindInit
	pagefindInit = new Promise((resolve) => {
		if (typeof window === 'undefined') {
			resolve(null)
			return
		}
		dynamicImport(withBase('/pagefind/pagefind.js'))
			.then((mod) => {
				if (!mod) return resolve(null)
				if (mod.search) return resolve(mod)
				if (mod.default?.search) return resolve(mod.default)
				return resolve(mod.default || mod)
			})
			.catch(() => resolve(null))
	})
	return pagefindInit
}

const defaultUiOptions = {
	element: '#pagefind-ui',
	showImages: false,
	resetStyles: false
}

const resolveTarget = (element) => {
	if (!element) return null
	if (typeof element === 'string') {
		return document.querySelector(element)
	}
	return element
}

const initPagefindUI = (options) => {
	const PagefindUI = window.PagefindUI
	if (!PagefindUI) return false
	const merged = { ...defaultUiOptions, ...(options || {}) }
	const target = resolveTarget(merged.element)
	if (!target) return false
	new PagefindUI(merged)
	pagefindUiReady = true
	return true
}

export const loadPagefindUI = async (options = {}) => {
	if (pagefindUiReady) return true
	if (pagefindUiInit) return pagefindUiInit
	pagefindUiInit = new Promise((resolve) => {
		if (typeof window === 'undefined') {
			resolve(false)
			return
		}
		const done = (value) => resolve(Boolean(value))
		if (window.PagefindUI) {
			done(initPagefindUI(options))
			return
		}
		const script = document.createElement('script')
		script.src = withBase('/pagefind/pagefind-ui.js')
		script.async = true
		script.onload = () => done(initPagefindUI(options))
		script.onerror = () => done(false)
		document.head.appendChild(script)
	})
	return pagefindUiInit
}

export const focusPagefindInput = () => {
	if (typeof document === 'undefined') return
	const input =
		document.querySelector('#pagefind-ui input[type="search"]') || document.querySelector('#pagefind-ui input')
	if (input) {
		input.focus()
	}
}
