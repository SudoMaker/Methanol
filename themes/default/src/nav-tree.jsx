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

import { If, For, $, signal, onCondition, read, extract } from 'refui'
import NullProtoObj from 'null-prototype-object'
import { HTMLRenderer } from 'methanol'

const navEntryMap = new Map()

const currentPath = signal('')
const matchCurrentPath = onCondition(currentPath)

const toSignal = (i) => {
	const clone = Object.assign(new NullProtoObj(), i)

	let sig = navEntryMap.get(clone.routePath)
	if (!sig) {
		sig = signal(clone)
		navEntryMap.set(clone.routePath, sig)
	} else {
		sig.value = clone
	}

	if (clone.type === 'directory') {
		clone.children = clone.children.map(toSignal)
	}

	return sig
}

const NavTree = ({ nodes, depth }) => (
	<For entries={nodes}>
		{({ item }) => {
			const node = read(item)
			const { routeHref: href, routePath, type, name, isRoot } = node
			const { title } = extract(item, 'title')

			const isActive = matchCurrentPath(routePath)

			if (type === 'directory') {
				const label = title.or(name)
				const { children } = extract(item, 'children')

				const isOpen = $(() => {
					if (depth < 1) {
						return true
					}
					const _active = isActive.value
					const _currentPath = currentPath.value
					return _active || _currentPath.startsWith(routePath)
				})

				const header = href ? (
					<a class={isActive.choose('nav-dir-link active', 'nav-dir-link')} href={href}>
						{label}
					</a>
				) : (
					<span class="nav-dir-label">{label}</span>
				)

				return (
					<li class={isActive.choose('is-active', null)}>
						<details class="sidebar-collapsible" open={isOpen.choose(true, null)}>
							<summary class="sb-dir-header">{header}</summary>
							<If condition={() => children.value.length}>
								{() => (
									<ul data-depth={depth + 1}>
										<NavTree nodes={children} depth={depth + 1} />
									</ul>
								)}
							</If>
						</details>
					</li>
				)
			} else {
				const label = title.or(node.isIndex ? 'Home' : name)
				return (
					<li>
						<a class={isActive.choose('active', null)} href={href}>
							{label}
						</a>
					</li>
				)
			}
		}}
	</For>
)

const rootNodes = signal()
const rootTree = HTMLRenderer.createElement(NavTree, { nodes: rootNodes, depth: 0 })

export const renderNavTree = (nodes, path) => {
	currentPath.value = path
	rootNodes.value = nodes.map(toSignal)
	return rootTree
}
