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

import { HTMLRenderer as R } from './renderer.js'

export const DevErrorPage = ({ message = '', basePrefix = ''} = {}) => (
	<>
		{R.rawHTML`<!doctype html>`}
		<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>Methanol dev error</title>
				<style>{`
					body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0f1115; color: #e9edf1; }
					.main { padding: 24px; max-width: 960px; }
					h1 { margin: 0 0 12px; font-size: 20px; }
					pre { white-space: pre-wrap; background: #151922; padding: 16px; border-radius: 8px; border: 1px solid #2a2f3a; }
					.note { color: #9aa3ad; font-size: 12px; margin-top: 12px; }
				`}</style>
			</head>
			<body>
				<div class="main">
					<h1>Dev server error</h1>
					<pre>{message}</pre>
					<div class="note">Fix the error and save to reload.</div>
				</div>
			</body>
		</html>
	</>
)

