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

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
	const base = resolveBasePrefix()
	const scope = base ? `${base}/` : '/'
	const swUrl = `${scope}sw.js`
	navigator.serviceWorker
		.register(swUrl)
		.then(() => navigator.serviceWorker.ready)
		.then((reg) => {
			reg.active?.postMessage({ type: 'METHANOL_WARM_MANIFEST' })
		})
		.catch(() => {})
}
