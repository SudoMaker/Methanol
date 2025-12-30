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

import { readdir, stat, copyFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve, dirname, relative } from 'path'

const ensureDir = async (dir) => {
	await mkdir(dir, { recursive: true })
}

const copyDir = async (sourceDir, targetDir, onFile) => {
	await ensureDir(targetDir)
	const entries = await readdir(sourceDir)
	for (const entry of entries) {
		if (entry.startsWith('.')) {
			continue
		}
		const sourcePath = resolve(sourceDir, entry)
		const targetPath = resolve(targetDir, entry)
		const stats = await stat(sourcePath)
		if (stats.isDirectory()) {
			await copyDir(sourcePath, targetPath, onFile)
		} else {
			if (existsSync(targetPath)) {
				if (onFile) {
					onFile(sourcePath, targetPath, { skipped: true })
				}
				continue
			}
			await ensureDir(dirname(targetPath))
			await copyFile(sourcePath, targetPath)
			if (onFile) {
				onFile(sourcePath, targetPath, { skipped: false })
			}
		}
	}
}

export const copyPublicDir = async ({ sourceDir, targetDir, label = 'public' }) => {
	if (!sourceDir || !targetDir) return
	if (!existsSync(sourceDir)) return
	const resolvedSource = resolve(sourceDir)
	const resolvedTarget = resolve(targetDir)
	if (resolvedSource === resolvedTarget) return
	const created = !existsSync(resolvedTarget)
	await ensureDir(resolvedTarget)
	if (created) {
		console.log(`Methanol: created ${label} directory`)
	}
	await copyDir(resolvedSource, resolvedTarget, (sourcePath, targetPath, info) => {
		const rel = relative(resolvedSource, sourcePath).replace(/\\/g, '/')
		if (info?.skipped) return
		console.log(`Methanol: copied ${label}/${rel}`)
	})
}
