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

const ACCENTS = [
	{ id: 'default', label: 'Amber', color: '#ffa000' },
	{ id: 'rose', label: 'Rose', color: '#f43f5e' },
	{ id: 'blue', label: 'Indigo', color: '#818cf8' },
	{ id: 'green', label: 'Teal', color: '#2dd4bf' },
	{ id: 'purple', label: 'Violet', color: '#a78bfa' }
]

export default function () {
	const currentAccent = signal('default')
	const isOpen = signal(false)

	// Initialize theme from localStorage
	if (typeof window !== 'undefined') {
		const saved = localStorage.getItem('methanol-accent')
		if (saved && ACCENTS.some((a) => a.id === saved)) {
			currentAccent.value = saved
			if (saved !== 'default') {
				document.documentElement.classList.add(`accent-${saved}`)
			}
		}

		// Close popup when clicking outside
		document.addEventListener('click', (e) => {
			if (!e.target.closest('.theme-switch-wrapper')) {
				isOpen.value = false
			}
		})
	}

	const setAccent = (id) => {
		const oldId = currentAccent.value

		// Remove old
		if (oldId !== 'default') {
			document.documentElement.classList.remove(`accent-${oldId}`)
		}

		// Add new
		if (id !== 'default') {
			document.documentElement.classList.add(`accent-${id}`)
		}

		currentAccent.value = id
		localStorage.setItem('methanol-accent', id)
		isOpen.value = false
	}

	const togglePopup = () => {
		isOpen.value = !isOpen.value
	}

	return (
		<div class="theme-switch-container">
			<div class="theme-switch-wrapper">
				<div class={$(() => `accent-popup ${isOpen.value ? 'open' : ''}`)}>
					{ACCENTS.map((accent) => (
						<button
							class={$(() => `accent-option ${currentAccent.value === accent.id ? 'active' : ''}`)}
							on:click={() => setAccent(accent.id)}
						>
							<span class="option-circle" style={`background-color: ${accent.color}`}></span>
							{accent.label}
						</button>
					))}
				</div>
				<button class="theme-switch-btn" on:click={togglePopup} attr:aria-label="Select accent color">
					<div class="accent-circle"></div>
				</button>
			</div>
		</div>
	)
}
