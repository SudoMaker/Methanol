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

import { sourceManifestKeys } from './rsbuild-plugins.js'

const withoutPrefix = (value) => String(value || '').replace(/^\//, '')
const isHotUpdate = (value) => String(value || '').includes('.hot-update.')

const compilationsFrom = (stats) => {
	if (!stats) return []
	if (Array.isArray(stats.stats)) {
		return stats.stats.map((item) => item?.compilation).filter(Boolean)
	}
	return stats.compilation ? [stats.compilation] : []
}

export const entryAssetsFromStats = (stats, entryName) => {
	for (const compilation of compilationsFrom(stats)) {
		const entrypoint = compilation.entrypoints?.get?.(entryName)
		if (!entrypoint) continue
		const files = Array.from(entrypoint.getFiles?.() || [])
			.filter((file) => !isHotUpdate(file))
			.map(withoutPrefix)
		return {
			js: files.filter((file) => /\.(?:m?js|cjs)(?:\?|$)/.test(file)),
			css: files.filter((file) => /\.css(?:\?|$)/.test(file))
		}
	}
	return null
}

const addSourceAssets = (manifest, stats) => {
	for (const compilation of compilationsFrom(stats)) {
		for (const asset of compilation.getAssets?.() || []) {
			const sourceFilename = asset?.info?.sourceFilename
			if (!sourceFilename || !asset?.name) continue
			for (const key of sourceManifestKeys(sourceFilename)) {
				manifest[key] = { file: withoutPrefix(asset.name) }
			}
		}
	}
}

export const createAssetManifest = ({ entryRecords, stats }) => {
	const manifest = {}
	for (const record of entryRecords || []) {
		if (!record?.entryName || !record?.manifestKey) continue
		const output = entryAssetsFromStats(stats, record.entryName)
		if (!output) continue
		const file = record.kind === 'style'
			? output.css[0] || output.js.at(-1)
			: output.js.at(-1) || output.css[0]
		if (!file) continue
		manifest[record.manifestKey] = {
			file,
			js: output.js,
			css: output.css
		}
	}
	addSourceAssets(manifest, stats)
	return manifest
}
