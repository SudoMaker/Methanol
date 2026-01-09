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

import { resolve } from 'path'
import yargs from 'yargs/yargs'
import { hideBin } from 'yargs/helpers'

const PROJECT_ROOT = resolve('.')

const withCommonOptions = (y) =>
	y
		.positional('input', {
			describe: 'Pages directory',
			type: 'string',
			nargs: 1
		})
		.positional('output', {
			describe: 'Output directory',
			type: 'string',
			nargs: 1
		})
		.option('input', {
			alias: 'i',
			describe: 'Pages directory',
			type: 'string',
			requiresArg: true,
			nargs: 1
		})
		.option('components', {
			describe: 'Components directory',
			type: 'string',
			requiresArg: true,
			nargs: 1
		})
		.option('assets', {
			describe: 'Assets/public directory',
			type: 'string',
			requiresArg: true,
			nargs: 1
		})
		.option('output', {
			alias: 'o',
			describe: 'Output directory',
			type: 'string',
			requiresArg: true,
			nargs: 1
		})
		.option('config', {
			alias: 'c',
			describe: 'Config file path',
			type: 'string',
			requiresArg: true,
			nargs: 1
		})
		.option('site-name', {
			describe: 'Site name override',
			type: 'string',
			requiresArg: true,
			nargs: 1
		})
		.option('port', {
			describe: 'Port for dev/preview',
			type: 'number',
			requiresArg: true,
			nargs: 1
		})
		.option('host', {
			describe: 'Host for dev/preview',
			type: 'string',
			coerce: (value) => {
				if (value == null) return null
				if (value === true || value === '' || value === 'true') return true
				return value
			}
		})
		.option('intermediate-dir', {
			describe: 'Write intermediate HTML output to a directory',
			type: 'string',
			requiresArg: true,
			nargs: 1
		})
		.option('emit-intermediate', {
			describe: 'Emit intermediate HTML output to the default build dir',
			type: 'boolean',
			default: false
		})
		.option('code-highlighting', {
			describe: 'Enable or disable code highlighting',
			type: 'boolean',
			coerce: (value) => {
				if (value == null) return null
				if (typeof value === 'boolean') return value
				const normalized = String(value).trim().toLowerCase()
				if (normalized === 'true') return true
				if (normalized === 'false') return false
				return null
			}
		})
		.option('verbose', {
			alias: 'v',
			describe: 'Enable verbose output',
			type: 'boolean',
			default: false
		})
		.option('base', {
			describe: 'Base URL override',
			type: 'string',
			requiresArg: true,
			nargs: 1
		})

const parser = yargs(hideBin(process.argv))
	.scriptName('methanol')
	.usage('Usage: $0 <command> [options]')
	.command('dev [input]', 'Start the Methanol dev server', withCommonOptions)
	.command('build [input] [output]', 'Build the static site', withCommonOptions)
	.command('serve [input] [output]', 'Serve the production build', withCommonOptions)
	.command('preview [input] [output]', false, withCommonOptions)
	.help()
	.wrap(null)

const argv = parser.parseSync()

export const cli = {
	argv,
	command: argv._[0] ? String(argv._[0]) : null,
	showHelp: () => parser.showHelp(),
	CLI_INTERMEDIATE_DIR: argv['intermediate-dir'] || null,
	CLI_EMIT_INTERMEDIATE: Boolean(argv['emit-intermediate']),
	CLI_HOST: argv.host ?? null,
	CLI_PORT: typeof argv.port === 'number' ? argv.port : null,
	CLI_PAGES_DIR: argv.input || null,
	CLI_COMPONENTS_DIR: argv.components || null,
	CLI_ASSETS_DIR: argv.assets || null,
	CLI_OUTPUT_DIR: argv.output || null,
	CLI_CONFIG_PATH: argv.config || null,
	CLI_SITE_NAME: argv['site-name'] || null,
	CLI_CODE_HIGHLIGHTING: typeof argv['code-highlighting'] === 'boolean' ? argv['code-highlighting'] : null,
	CLI_VERBOSE: Boolean(argv.verbose),
	CLI_BASE: argv.base || null
}

export const state = {
	PROJECT_ROOT,
	ROOT_DIR: PROJECT_ROOT,
	SITE_NAME: 'Methanol Site',
	SITE_BASE: null,
	VITE_BASE: null,
	PAGES_DIR: resolve(PROJECT_ROOT, 'pages'),
	COMPONENTS_DIR: resolve(PROJECT_ROOT, 'components'),
	STATIC_DIR: resolve(PROJECT_ROOT, 'public'),
	BUILD_DIR: resolve(PROJECT_ROOT, 'build'),
	DIST_DIR: resolve(PROJECT_ROOT, 'dist'),
	VIRTUAL_HTML_OUTPUT_ROOT: PROJECT_ROOT,
	INTERMEDIATE_DIR: null,
	THEME_COMPONENTS_DIR: null,
	THEME_PAGES_DIR: null,
	THEME_PUBLIC_DIR: null,
	THEME_ENV: null,
	USER_THEME: null,
	USER_SITE: null,
	USER_VITE_CONFIG: null,
	USER_MDX_CONFIG: null,
	USER_PUBLIC_OVERRIDE: false,
	SOURCES: [],
	PAGEFIND_ENABLED: false,
	PAGEFIND_OPTIONS: null,
	PAGEFIND_BUILD: null,
	USER_PRE_BUILD_HOOKS: [],
	USER_POST_BUILD_HOOKS: [],
	USER_PRE_BUNDLE_HOOKS: [],
	USER_POST_BUNDLE_HOOKS: [],
	THEME_PRE_BUILD_HOOKS: [],
	THEME_POST_BUILD_HOOKS: [],
	THEME_PRE_BUNDLE_HOOKS: [],
	THEME_POST_BUNDLE_HOOKS: [],
	STARRY_NIGHT_ENABLED: false,
	STARRY_NIGHT_OPTIONS: null,
	GFM_ENABLED: true,
	CURRENT_MODE: 'production',
	RESOLVED_MDX_CONFIG: undefined,
	RESOLVED_VITE_CONFIG: undefined
}
