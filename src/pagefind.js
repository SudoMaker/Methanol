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

import { access } from 'fs/promises'
import { constants } from 'fs'
import { join, delimiter } from 'path'
import { spawn } from 'child_process'
import { state } from './state.js'

const resolvePagefindBin = async () => {
	const binName = process.platform === 'win32' ? 'pagefind.cmd' : 'pagefind'
	const candidates = [
		join(state.PROJECT_ROOT, 'node_modules', '.bin', binName),
		join(state.ROOT_DIR, 'node_modules', '.bin', binName)
	]
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK)
			return candidate
		} catch {}
	}
	const pathEntries = (process.env.PATH || '').split(delimiter).filter(Boolean)
	for (const entry of pathEntries) {
		const candidate = join(entry, binName)
		try {
			await access(candidate, constants.X_OK)
			return candidate
		} catch {}
	}
	return null
}

const toKebabCase = (value) =>
	String(value)
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replace(/_/g, '-')
		.toLowerCase()

const buildArgsFromOptions = (options) => {
	if (!options) return []
	if (Array.isArray(options)) {
		return options.map(String)
	}
	if (typeof options !== 'object') return []
	const args = []
	for (const [rawKey, rawValue] of Object.entries(options)) {
		if (!rawKey) continue
		const key = String(rawKey)
		const normalized = toKebabCase(key.replace(/^--/, ''))
		if (normalized === 'site' || normalized === 'site-dir' || normalized === 'source') {
			continue
		}
		const flag = key.startsWith('--') ? key : `--${normalized}`
		if (rawValue === true) {
			args.push(flag)
		} else if (rawValue === false || rawValue == null) {
			continue
		} else {
			args.push(flag, String(rawValue))
		}
	}
	return args
}

const runCommand = (command, args, options) =>
	new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: 'inherit',
			...options
		})
		child.on('close', (code) => resolve(code === 0))
		child.on('error', () => resolve(false))
	})

export const runPagefind = async () => {
	const bin = await resolvePagefindBin()
	if (!bin) {
		console.log('Pagefind not found; skipping search indexing.')
		return false
	}
	console.log('Running Pagefind search indexing...')
	const extraArgs = buildArgsFromOptions(state.PAGEFIND_BUILD)
	const ok = await runCommand(bin, ['--site', state.DIST_DIR, ...extraArgs], {
		cwd: state.PROJECT_ROOT
	})
	if (!ok) {
		console.warn('Pagefind failed to build search index.')
	}
	return ok
}
