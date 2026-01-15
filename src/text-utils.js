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

const DEFAULT_EXCERPT_LENGTH = 200

const collapseWhitespace = (value) => value.replace(/\s+/g, ' ').trim()

const stripFirstHeading = (value) => value.replace(/^\s{0,3}#{1,6}\s+.*$/m, ' ')

const stripMarkdown = (value) => {
	let text = value
	text = text.replace(/```[\s\S]*?```/g, ' ')
	text = text.replace(/`[^`]*`/g, ' ')
	text = stripFirstHeading(text)
	text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
	text = text.replace(/<[^>]+>/g, ' ')
	text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
	text = text.replace(/^\s{0,3}>\s?/gm, '')
	text = text.replace(/^\s*[-*+]\s+/gm, '')
	text = text.replace(/^\s*\d+\.\s+/gm, '')
	return collapseWhitespace(text)
}

export const extractExcerpt = (page, options = {}) => {
	if (!page) return ''
	const length =
		typeof options.length === 'number' && Number.isFinite(options.length)
			? options.length
			: DEFAULT_EXCERPT_LENGTH
	const raw =
		page.excerpt ||
		page.frontmatter?.excerpt ||
		page.frontmatter?.description ||
		page.content ||
		''
	const sanitized = stripMarkdown(String(raw))
	if (!sanitized) return ''
	if (length > 0 && sanitized.length > length) {
		return `${sanitized.slice(0, length).trim()}...`
	}
	return sanitized
}
