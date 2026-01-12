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

import { existsSync } from 'fs'
import { dirname, resolve, relative, isAbsolute } from 'path'
import { isElement } from 'hast-util-is-element'
import { visit } from 'unist-util-visit'
import { state } from '../state.js'

const extensionRegex = /\.(mdx?|html)$/i

const isRelativeHref = (href) => {
	if (!href) return false
	if (href.startsWith('#') || href.startsWith('?') || href.startsWith('/')) return false
	if (href.startsWith('//')) return false
	if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href)) return false
	return true
}

const splitHref = (href) => {
	const cutIndex = href.search(/[?#]/)
	if (cutIndex === -1) {
		return { path: href, suffix: '' }
	}
	return { path: href.slice(0, cutIndex), suffix: href.slice(cutIndex) }
}

const resolveCandidate = (baseDir, targetPath) => resolve(baseDir, targetPath)

const isWithinRoot = (root, targetPath) => {
	if (!root) return false
	const relPath = relative(root, targetPath)
	if (relPath === '') return true
	if (relPath.startsWith('..') || relPath.startsWith('..\\')) return false
	if (isAbsolute(relPath)) return false
	return true
}

const hasExistingSource = (baseDir, pathWithoutSuffix, extension, root) => {
	const targetPath = resolveCandidate(baseDir, `${pathWithoutSuffix}${extension}`)
	if (root && !isWithinRoot(root, targetPath)) {
		return false
	}
	return existsSync(targetPath)
}

const resolvePagesRoot = (filePath) => {
	const roots = [state.PAGES_DIR, state.THEME_PAGES_DIR].filter(Boolean).map((dir) => resolve(dir))
	if (!roots.length) return null
	if (!filePath) return roots[0]
	const resolvedFile = resolve(filePath)
	for (const root of roots) {
		if (isWithinRoot(root, resolvedFile)) {
			return root
		}
	}
	return roots[0]
}

export const linkResolve = () => {
	return (tree, file) => {
		const baseDir = file.path ? dirname(file.path) : file.cwd || process.cwd()
		const pagesRoot = resolvePagesRoot(file.path || null)
		visit(tree, (node) => {
			if (!isElement(node) || node.tagName !== 'a') {
				return
			}
			const href = node.properties?.href
			if (!isRelativeHref(href)) {
				return
			}

			const { path, suffix } = splitHref(href)
			const match = path.match(extensionRegex)
			if (!match) {
				return
			}
			const extension = match[0]
			const withoutExtension = path.replace(extensionRegex, '')

			let shouldStrip = false
			if (/\.mdx?$/i.test(extension)) {
				shouldStrip = hasExistingSource(baseDir, withoutExtension, extension, pagesRoot)
			} else if (/\.html$/i.test(extension)) {
				shouldStrip =
					hasExistingSource(baseDir, withoutExtension, extension, pagesRoot) ||
					hasExistingSource(baseDir, withoutExtension, '.md', pagesRoot) ||
					hasExistingSource(baseDir, withoutExtension, '.mdx', pagesRoot)
			}

			if (!shouldStrip) {
				return
			}

			node.properties.href = withoutExtension + suffix
		})
	}
}
