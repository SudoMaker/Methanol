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

const RSS_DECLARATION = R.rawHTML('<?xml version="1.0" encoding="UTF-8"?>')

const RssFeed = ({ site, items }) => {
	const title = site?.title || site?.name || 'Methanol Feed'
	const link = site?.url || null
	const description = site?.description || ''
	const language = site?.language || null
	const generator = site?.generator || 'Methanol'
	const lastBuildDate = site?.lastBuildDate || null
	return [
		RSS_DECLARATION,
		<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
			<channel>
				<title>{title}</title>
				{link ? <link>{link}</link> : null}
				<description>{description}</description>
				{language ? <language>{language}</language> : null}
				{generator ? <generator>{generator}</generator> : null}
				{lastBuildDate ? <lastBuildDate>{lastBuildDate}</lastBuildDate> : null}
				{Array.isArray(items)
					? items.map((item) => (
							<item>
								<title>{item.title}</title>
								<link>{item.link}</link>
								<guid isPermaLink="true">{item.link}</guid>
								{item.description ? <description>{item.description}</description> : null}
								{item.content ? <content:encoded>{item.content}</content:encoded> : null}
								{item.author ? <author>{item.author}</author> : null}
								{item.pubDate ? <pubDate>{item.pubDate}</pubDate> : null}
							</item>
						))
					: null}
			</channel>
		</rss>
	]
}

export default RssFeed
