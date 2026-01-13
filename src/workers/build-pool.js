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

import { cpus } from 'os'
import { Worker } from 'worker_threads'
import { state, cli } from '../state.js'

const BUILD_WORKER_URL = new URL('./build-worker.js', import.meta.url)

const resolveWorkerCount = (total) => {
	const cpuCount = Math.max(1, cpus()?.length || 1)
	const requested = state.WORKER_JOBS
	if (requested == null || requested <= 0) {
		const items = Math.max(1, Number.isFinite(total) ? total : 1)
		const autoCount = Math.round(Math.log(items))
		return Math.max(1, Math.min(cpuCount, autoCount))
	}
	return Math.max(1, Math.min(cpuCount, Math.floor(requested)))
}

export const createBuildWorkers = (pageCount, options = {}) => {
	const { command = 'build' } = options || {}
	const workerCount = Math.min(resolveWorkerCount(pageCount), pageCount || 1) || 1
	const workers = []
	for (let i = 0; i < workerCount; i += 1) {
		workers.push(
			new Worker(BUILD_WORKER_URL, {
				type: 'module',
				workerData: {
					mode: state.CURRENT_MODE,
					configPath: cli.CLI_CONFIG_PATH,
					command
				}
			})
		)
	}
	const assignments = Array.from({ length: workers.length }, () => [])
	for (let i = 0; i < pageCount; i += 1) {
		assignments[i % workers.length].push(i)
	}
	return { workers, assignments }
}

export const terminateWorkers = async (workers = []) => {
	await Promise.all(workers.map((worker) => worker.terminate().catch(() => null)))
}

export const runWorkerStage = async ({ workers, stage, messages, onProgress, collect }) => {
	return await new Promise((resolve, reject) => {
		let completed = 0
		let doneCount = 0
		const results = []
		const handleFailure = (error) => {
			for (const w of workers) {
				const handler = handlers.get(w)
				if (handler) {
					w.off('message', handler)
					w.off('error', errorHandlers.get(w))
					w.off('exit', exitHandlers.get(w))
				}
			}
			reject(error instanceof Error ? error : new Error(String(error)))
		}
		const handleMessage = (worker, message) => {
			if (!message || message.stage !== stage) return
			if (message.type === 'progress') {
				completed += 1
				if (onProgress) {
					onProgress(completed)
				}
				return
			}
			if (message.type === 'done') {
				if (collect) {
					const data = collect(message)
					if (Array.isArray(data) && data.length) {
						results.push(...data)
					}
				}
				doneCount += 1
				if (doneCount >= workers.length) {
					for (const w of workers) {
						const handler = handlers.get(w)
						if (handler) {
							w.off('message', handler)
							w.off('error', errorHandlers.get(w))
							w.off('exit', exitHandlers.get(w))
						}
					}
					resolve(results)
				}
				return
			}
			if (message.type === 'error') {
				handleFailure(new Error(message.error || 'Worker error'))
			}
		}
		const handlers = new Map()
		const errorHandlers = new Map()
		const exitHandlers = new Map()
		for (const worker of workers) {
			const handler = (message) => handleMessage(worker, message)
			handlers.set(worker, handler)
			worker.on('message', handler)
			const errorHandler = (error) => handleFailure(error)
			const exitHandler = (code) => {
				if (code !== 0) {
					handleFailure(new Error(`Build worker exited with code ${code}`))
				}
			}
			errorHandlers.set(worker, errorHandler)
			exitHandlers.set(worker, exitHandler)
			worker.on('error', errorHandler)
			worker.on('exit', exitHandler)
		}
		for (const entry of messages) {
			entry.worker.postMessage(entry.message)
		}
	})
}
