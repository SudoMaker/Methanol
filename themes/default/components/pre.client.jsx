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

import { signal } from 'refui'

export default function (props, ...children) {
	const el = signal()
	const copied = signal(false)

	const copy = async function () {
		if (el.value) {
			try {
				await navigator.clipboard.writeText(el.value.textContent)
				copied.value = true
				setTimeout(() => {
					copied.value = false
				}, 2000)
			} catch (err) {
				console.error('Failed to copy: ', err)
			}
		}
	}

	const BtnImg = copied.choose(
		() => (
			<svg
				attr:width="14"
				attr:height="14"
				attr:viewBox="0 0 24 24"
				attr:fill="none"
				attr:stroke="currentColor"
				attr:stroke-width="2.5"
				attr:stroke-linecap="round"
				attr:stroke-linejoin="round"
				class="text-accent"
			>
				<polyline attr:points="20 6 9 17 4 12"></polyline>
			</svg>
		),
		() => (
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
				<rect attr:x="9" attr:y="9" attr:width="13" attr:height="13" attr:rx="2" attr:ry="2"></rect>
				<path attr:d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
			</svg>
		)
	)

	return (
		<div class="code-block-container">
			<button class="copy-btn" on:click={copy} attr:aria-label="Copy code">
				<BtnImg />
			</button>
			<pre {...props} $ref={el}>
				{...children}
			</pre>
		</div>
	)
}
