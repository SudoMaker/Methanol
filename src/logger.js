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

const supportColor =
	typeof process !== 'undefined' &&
	process.stdout &&
	(process.stdout.isTTY || process.env.FORCE_COLOR)

const formatter = (open, close, replace = open) =>
	supportColor
		? (input) => {
				const string = '' + input
				const index = string.indexOf(close, open.length)
				return ~index
					? open + getReplace(string, index, close, replace) + close
					: open + string + close
			}
		: (input) => '' + input

const getReplace = (string, index, close, replace) => {
	const head = string.substring(0, index) + replace
	const tail = string.substring(index + close.length)
	const next = tail.indexOf(close)
	return ~next ? head + getReplace(tail, next, close, replace) : head + tail
}

export const style = {
	reset: formatter('\x1b[0m', '\x1b[0m'),
	bold: formatter('\x1b[1m', '\x1b[22m', '\x1b[22m\x1b[1m'),
	dim: formatter('\x1b[2m', '\x1b[22m', '\x1b[22m\x1b[2m'),
	italic: formatter('\x1b[3m', '\x1b[23m'),
	underline: formatter('\x1b[4m', '\x1b[24m'),
	inverse: formatter('\x1b[7m', '\x1b[27m'),
	hidden: formatter('\x1b[8m', '\x1b[28m'),
	strikethrough: formatter('\x1b[9m', '\x1b[29m'),

	black: formatter('\x1b[30m', '\x1b[39m'),
	red: formatter('\x1b[31m', '\x1b[39m'),
	green: formatter('\x1b[32m', '\x1b[39m'),
	yellow: formatter('\x1b[33m', '\x1b[39m'),
	blue: formatter('\x1b[34m', '\x1b[39m'),
	magenta: formatter('\x1b[35m', '\x1b[39m'),
	cyan: formatter('\x1b[36m', '\x1b[39m'),
	white: formatter('\x1b[37m', '\x1b[39m'),
	gray: formatter('\x1b[90m', '\x1b[39m'),

	bgBlack: formatter('\x1b[40m', '\x1b[49m'),
	bgRed: formatter('\x1b[41m', '\x1b[49m'),
	bgGreen: formatter('\x1b[42m', '\x1b[49m'),
	bgYellow: formatter('\x1b[43m', '\x1b[49m'),
	bgBlue: formatter('\x1b[44m', '\x1b[49m'),
	bgMagenta: formatter('\x1b[45m', '\x1b[49m'),
	bgCyan: formatter('\x1b[46m', '\x1b[49m'),
	bgWhite: formatter('\x1b[47m', '\x1b[49m')
}

export const logger = {
	info: (msg) => console.log(`${style.blue('ℹ')}  ${msg}`),
	success: (msg) => console.log(`${style.green('✔')}  ${msg}`),
	warn: (msg) => console.log(`${style.yellow('⚠')}  ${msg}`),
	error: (msg) => console.log(`${style.red('✖')}  ${msg}`),
	dim: (msg) => console.log(style.dim(msg))
}
