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

import { readdir, stat, lstat, copyFile, mkdir, symlink, unlink, rm, link } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve, dirname, relative, parse } from 'path'

const ensureDir = async (dir) => {
	await mkdir(dir, { recursive: true })
}

const isWindows = process.platform === 'win32'

const linkOrCopyFile = async (src, dest) => {
	try {
		try {
			await lstat(dest)
			await unlink(dest)
		} catch (e) {
			if (e.code !== 'ENOENT') {
				try {
					await rm(dest, { recursive: true, force: true })
				} catch (e2) {
					console.error(`Methanol: Failed to clean destination ${dest}`, e2)
				}
			}
		}
	} catch (err) {
		console.error(`Methanol: Failed to remove existing file at ${dest}`, err)
	}

	try {
		await ensureDir(dirname(dest))

		if (isWindows) {
			// Windows: Check for different drives first
			if (parse(src).root.toLowerCase() !== parse(dest).root.toLowerCase()) {
				await copyFile(src, dest)
				return 'copied'
			}

			// Try hard link (no admin required)
			try {
				await link(src, dest)
				return 'hardlinked'
			} catch (err) {
				// Fallback to copy
				// console.warn(`Methanol: Hardlink failed for ${src} -> ${dest}. Falling back to copy.`, err.message)
				await copyFile(src, dest)
				return 'copied (fallback)'
			}
		} else {
			// macOS/Linux: Symlink
			await symlink(src, dest)
			return 'symlinked'
		}
	} catch (err) {
		console.error(`Methanol: Failed to link ${src} to ${dest}`, err)
		return 'failed'
	}
}

const processDir = async (sourceDir, targetDir, accumulated = new Set()) => {
	if (!existsSync(sourceDir)) return
	const entries = await readdir(sourceDir)
	for (const entry of entries) {
		if (entry.startsWith('.')) continue
		const sourcePath = resolve(sourceDir, entry)
		const targetPath = resolve(targetDir, entry)
		const stats = await stat(sourcePath)

		if (stats.isDirectory()) {
			await processDir(sourcePath, targetPath, accumulated)
		} else {
			await linkOrCopyFile(sourcePath, targetPath)
			accumulated.add(relative(targetDir, targetPath))
		}
	}
}

export const preparePublicAssets = async ({ themeDir, userDir, targetDir }) => {
	if (existsSync(targetDir)) {
		await rm(targetDir, { recursive: true, force: true })
	}
	await ensureDir(targetDir)

	if (themeDir) {
		await processDir(themeDir, targetDir)
	}

	if (userDir) {
		await processDir(userDir, targetDir)
	}
}

export const updateAsset = async ({ type, filePath, themeDir, userDir, targetDir, relPath }) => {
	const targetPath = resolve(targetDir, relPath)

	if (type === 'unlink') {
		try {
			try {
				await unlink(targetPath)
			} catch (e) {
				if (e.code !== 'ENOENT') {
					await rm(targetPath, { recursive: true, force: true })
				}
			}

			if (themeDir) {
				const themePath = resolve(themeDir, relPath)
				if (existsSync(themePath)) {
					await linkOrCopyFile(themePath, targetPath)
					return 'restored theme asset'
				}
			}
		} catch (err) {
			console.error(`Methanol: Error updating asset ${relPath}`, err)
		}
		return 'removed'
	} else {
		const sourcePath = userDir ? resolve(userDir, relPath) : null
		if (sourcePath && existsSync(sourcePath)) {
			await linkOrCopyFile(sourcePath, targetPath)
			return 'updated'
		}
	}
}
