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

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export const createStageLogger = (enabled) => {
	let lastLength = 0
	const isTty = Boolean(process.stdout && process.stdout.isTTY)
	const writeLine = (text, newline) => {
		if (!process.stdout || !process.stdout.write) {
			if (newline) {
				console.log(text)
			}
			return
		}
		if (!isTty) {
			if (newline) {
				console.log(text)
			}
			return
		}
		const padding = lastLength > text.length ? ' '.repeat(lastLength - text.length) : ''
		const clearLine = '\u001b[2K'
		process.stdout.write(`${clearLine}\r${text}${padding}${newline ? '\n' : ''}`)
		lastLength = text.length
	}
	const start = (label) => {
		if (!enabled) return null
		writeLine(`${label}...`, false)
		return { label, start: now() }
	}
	const update = (token, message) => {
		if (!enabled || !token || !message) return
		writeLine(message, false)
	}
	const end = (token) => {
		if (!enabled || !token) return
		const duration = Math.round(now() - token.start)
		writeLine(`${token.label}...\t${duration}ms`, true)
	}
	return { start, update, end }
}
