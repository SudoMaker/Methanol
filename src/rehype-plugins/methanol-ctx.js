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

import { extname } from 'path'

function createConst(name, init) {
	return {
		type: 'VariableDeclaration',
		kind: 'const',
		declarations: [
			{
				type: 'VariableDeclarator',
				id: { type: 'Identifier', name },
				init
			}
		]
	}
}

function argumentMember(name) {
	return {
		type: 'MemberExpression',
		object: {
			type: 'MemberExpression',
			object: { type: 'Identifier', name: 'arguments' },
			property: { type: 'Literal', value: 0 },
			computed: true,
			optional: false
		},
		property: { type: 'Identifier', name },
		computed: false,
		optional: false
	}
}

const ctxFrontmatter = {
	type: 'ChainExpression',
	expression: {
		type: 'MemberExpression',
		object: {
			type: 'MemberExpression',
			object: { type: 'Identifier', name: 'ctx' },
			property: { type: 'Identifier', name: 'page' },
			computed: false,
			optional: false
		},
		property: { type: 'Identifier', name: 'frontmatter' },
		computed: false,
		optional: true
	}
}

export function methanolCtx() {
	return (tree, file) => {
		// const filePath = file?.path || ''

		tree.children.unshift({
			type: 'mdxjsEsm',
			data: {
				estree: {
					type: 'Program',
					sourceType: 'module',
					body: [
						createConst('rawHTML', argumentMember('rawHTML')),
						createConst('ctx', argumentMember('ctx')),
						createConst('frontmatter', ctxFrontmatter)
					]
				}
			}
		})
	}
}
