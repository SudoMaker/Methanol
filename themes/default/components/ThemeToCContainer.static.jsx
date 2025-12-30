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

const buildTocItems = (items = []) => {
	const nodes = []
	for (const item of items) {
		const childNodes = item?.children?.length ? buildTocItems(item.children) : []
		const children = childNodes.length ? <ul>{childNodes}</ul> : null
		if (item.depth < 2 || item.depth > 4) {
			if (childNodes.length) {
				nodes.push(...childNodes)
			}
			continue
		}
		nodes.push(
			<li class={`toc-depth-${item.depth}`}>
				<a href={`#${item.id}`}>{item.value}</a>
				{children}
			</li>
		)
	}
	return nodes
}

export const renderToc = (toc = []) => {
	const items = buildTocItems(toc)
	if (!items.length) return null
	return items
}

export default function (props, ...children) {
	if (!children.length) {
		return
	}

	return (
		<aside class="toc-panel">
			<div class="toc">
				<h4>On this page</h4>
				<ul>{...children}</ul>
			</div>
		</aside>
	)
}
