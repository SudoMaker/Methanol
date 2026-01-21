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

import { HTMLRenderer as R } from 'methanol'

const ATOM_DECLARATION = R.rawHTML('<?xml version="1.0" encoding="UTF-8"?>')

const AtomFeed = ({ site, items }) => {
	const title = site?.title || site?.name || 'Methanol Feed'
	const siteUrl = site?.url || null
	const feedUrl = site?.feedUrl || null
	const updated = site?.updated || new Date().toISOString()
	const generator = site?.generator || 'Methanol'
	return [
		ATOM_DECLARATION,
		<feed xmlns="http://www.w3.org/2005/Atom">
			<title>{title}</title>
			{siteUrl ? <link href={siteUrl} /> : null}
			{feedUrl ? <link rel="self" href={feedUrl} /> : null}
			<id>{feedUrl || siteUrl || title}</id>
			<updated>{updated}</updated>
			{generator ? <generator>{generator}</generator> : null}
			{Array.isArray(items)
				? items.map((item) => (
						<entry>
							<title>{item.title}</title>
							<link href={item.link} />
							<id>{item.link}</id>
							{item.description ? <summary>{item.description}</summary> : null}
							{item.content ? <content type="html">{item.content}</content> : null}
							{item.updated ? <updated>{item.updated}</updated> : null}
						</entry>
					))
				: null}
		</feed>
	]
}

export default AtomFeed
