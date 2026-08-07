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

import { readdir, stat, lstat, copyFile, mkdir, symlink, rm, link } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve, dirname, parse } from 'path'

const ensureDir = async (dir) => {
	await mkdir(dir, { recursive: true })
}

const isWindows = process.platform === 'win32'

const linkOrCopyFile = async (src, dest) => {
	await rm(dest, { recursive: true, force: true })
	await ensureDir(dirname(dest))

	if (isWindows) {
		if (parse(src).root.toLowerCase() !== parse(dest).root.toLowerCase()) {
			await copyFile(src, dest)
			return 'copied'
		}

		try {
			await link(src, dest)
			return 'hardlinked'
		} catch {
			await copyFile(src, dest)
			return 'copied'
		}
	}

	await symlink(src, dest)
	return 'symlinked'
}

const ensureTargetDir = async (targetDir) => {
	try {
		const info = await lstat(targetDir)
		if (info.isDirectory()) return
		await rm(targetDir, { recursive: true, force: true })
	} catch (error) {
		if (error.code !== 'ENOENT') throw error
	}
	await ensureDir(targetDir)
}

const processDir = async (sourceDir, targetDir) => {
	if (!existsSync(sourceDir)) return
	await ensureTargetDir(targetDir)
	const entries = await readdir(sourceDir, { withFileTypes: true })
	for (const entry of entries) {
		const name = entry.name
		if (name.startsWith('.')) continue
		const sourcePath = resolve(sourceDir, name)
		const targetPath = resolve(targetDir, name)

		const isDirectory = entry.isDirectory() || (
			entry.isSymbolicLink() && (await stat(sourcePath)).isDirectory()
		)
		if (isDirectory) {
			await processDir(sourcePath, targetPath)
		} else {
			await linkOrCopyFile(sourcePath, targetPath)
		}
	}
}

const restoreThemeAsset = async (themePath, targetPath) => {
	const info = await lstat(themePath)
	if (info.isDirectory()) {
		await processDir(themePath, targetPath)
		return 'restored theme assets'
	}
	await linkOrCopyFile(themePath, targetPath)
	return 'restored theme asset'
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

export const updateAsset = async ({ type, themeDir, userDir, targetDir, relPath }) => {
	const targetPath = resolve(targetDir, relPath)

	if (type === 'unlink' || type === 'unlinkDir') {
		await rm(targetPath, { recursive: true, force: true })
		if (themeDir) {
			const themePath = resolve(themeDir, relPath)
			if (existsSync(themePath)) {
				return await restoreThemeAsset(themePath, targetPath)
			}
		}
		return 'removed'
	}

	const sourcePath = userDir ? resolve(userDir, relPath) : null
	if (!sourcePath || !existsSync(sourcePath)) return null
	const info = await lstat(sourcePath)
	if (info.isDirectory()) {
		await ensureTargetDir(targetPath)
		return 'updated directory'
	}
	await linkOrCopyFile(sourcePath, targetPath)
	return 'updated'
}
