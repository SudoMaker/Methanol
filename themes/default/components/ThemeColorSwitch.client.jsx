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

import { signal, $ } from 'refui'

const LightIcon = () => (
	<svg
		attr:width="18"
		attr:height="18"
		attr:viewBox="0 0 24 24"
		attr:fill="none"
		attr:stroke="currentColor"
		attr:stroke-width="2"
		attr:stroke-linecap="round"
		attr:stroke-linejoin="round"
	>
		<circle attr:cx="12" attr:cy="12" attr:r="5"></circle>
		<line attr:x1="12" attr:y1="1" attr:x2="12" attr:y2="3"></line>
		<line attr:x1="12" attr:y1="21" attr:x2="12" attr:y2="23"></line>
		<line attr:x1="4.22" attr:y1="4.22" attr:x2="5.64" attr:y2="5.64"></line>
		<line attr:x1="18.36" attr:y1="18.36" attr:x2="19.78" attr:y2="19.78"></line>
		<line attr:x1="1" attr:y1="12" attr:x2="3" attr:y2="12"></line>
		<line attr:x1="21" attr:y1="12" attr:x2="23" attr:y2="12"></line>
		<line attr:x1="4.22" attr:y1="19.78" attr:x2="5.64" attr:y2="18.36"></line>
		<line attr:x1="18.36" attr:y1="5.64" attr:x2="19.78" attr:y2="4.22"></line>
	</svg>
)

const DarkIcon = () => (
	<svg
		attr:width="18"
		attr:height="18"
		attr:viewBox="0 0 24 24"
		attr:fill="none"
		attr:stroke="currentColor"
		attr:stroke-width="2"
		attr:stroke-linecap="round"
		attr:stroke-linejoin="round"
	>
		<path attr:d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
	</svg>
)

export default function () {
	const theme = signal('dark')

	// Initialize theme from localStorage or system preference
	if (typeof window !== 'undefined') {
		const savedTheme = localStorage.getItem('methanol-theme')
		const systemTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
		theme.value = savedTheme || systemTheme
		document.documentElement.classList.toggle('light', theme.value === 'light')
		document.documentElement.classList.toggle('dark', theme.value === 'dark')
	}

	const toggle = () => {
		theme.value = theme.value === 'light' ? 'dark' : 'light'
		localStorage.setItem('methanol-theme', theme.value)
		document.documentElement.classList.toggle('light', theme.value === 'light')
		document.documentElement.classList.toggle('dark', theme.value === 'dark')
	}

	const CurrentIcon = $(() => {
		if (theme.value === 'light') {
			return LightIcon
		} else {
			return DarkIcon
		}
	})

	return (
		<div class="theme-switch-container">
			<button class="theme-switch-btn" on:click={toggle} attr:aria-label="Toggle theme">
				<CurrentIcon />
			</button>
		</div>
	)
}
