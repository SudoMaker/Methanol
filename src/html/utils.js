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

import { createHash } from 'crypto'

export const hashMd5 = (value) =>
	createHash('md5').update(value).digest('hex')

export const splitUrlParts = (value) => {
	if (!value) return { path: '', suffix: '' }
	const hashIndex = value.indexOf('#')
	const queryIndex = value.indexOf('?')
	let end = value.length
	if (hashIndex >= 0) end = Math.min(end, hashIndex)
	if (queryIndex >= 0) end = Math.min(end, queryIndex)
	const path = value.slice(0, end)
	const suffix = value.slice(end)
	return { path, suffix }
}

export const isExternalUrl = (value) => {
	if (!value) return false
	const trimmed = value.trim().toLowerCase()
	if (!trimmed) return false
	return (
		trimmed.startsWith('http://') ||
		trimmed.startsWith('https://') ||
		trimmed.startsWith('//') ||
		trimmed.startsWith('data:') ||
		trimmed.startsWith('mailto:') ||
		trimmed.startsWith('tel:') ||
		trimmed.startsWith('javascript:')
	)
}

export const resolvePageBase = (routePath) => {
	if (!routePath || routePath === '/') return '/'
	if (routePath.endsWith('/')) return routePath
	const index = routePath.lastIndexOf('/')
	if (index <= 0) return '/'
	return `${routePath.slice(0, index)}/`
}

export const stripBasePrefix = (value, basePrefix) => {
	if (!value || !basePrefix || basePrefix === '/') return value
	const trimmedBase = basePrefix.endsWith('/') ? basePrefix.slice(0, -1) : basePrefix
	if (!trimmedBase) return value
	if (value === trimmedBase) return '/'
	if (value.startsWith(`${trimmedBase}/`)) {
		const next = value.slice(trimmedBase.length)
		return next.startsWith('/') ? next : `/${next}`
	}
	return value
}

export const joinBasePrefix = (basePrefix, value) => {
	if (!value) return value
	if (!basePrefix || basePrefix === '/') {
		return value.startsWith('/') ? value : `/${value}`
	}
	const trimmedBase = basePrefix.endsWith('/') ? basePrefix.slice(0, -1) : basePrefix
	const normalized = value.startsWith('/') ? value : `/${value}`
	return `${trimmedBase}${normalized}`
}

export const resolveManifestKey = (value, basePrefix, pageRoutePath) => {
	if (!value || isExternalUrl(value)) return null
	const { path } = splitUrlParts(value)
	if (!path) return null
	const withoutBase = stripBasePrefix(path, basePrefix)
	const resolvedPath = withoutBase.startsWith('/')
		? withoutBase
		: new URL(withoutBase, `http://methanol${resolvePageBase(pageRoutePath)}`).pathname
	const key = resolvedPath.startsWith('/') ? resolvedPath.slice(1) : resolvedPath
	return { key, resolvedPath }
}

export const getAttr = (node, name) => {
	const attrs = node.attrs || []
	const attr = attrs.find((item) => item.name === name)
	return attr ? attr.value : null
}

export const setAttr = (node, name, value) => {
	const attrs = node.attrs || []
	const existing = attrs.find((item) => item.name === name)
	if (existing) {
		existing.value = value
	} else {
		attrs.push({ name, value })
	}
	node.attrs = attrs
}

export const getTextContent = (node) => {
	if (!node.childNodes) return ''
	return node.childNodes
		.map((child) => (child.nodeName === '#text' ? child.value : ''))
		.join('')
}

export const walkNodes = async (node, visitor) => {
	await visitor(node)
	if (!node.childNodes) return
	for (const child of node.childNodes) {
		await walkNodes(child, visitor)
	}
}
