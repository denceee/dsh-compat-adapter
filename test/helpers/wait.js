/**
 * Deterministic wait helpers for listener-driven tests.
 *
 * The adapter's hooks run asynchronously: a Host event reaches a listener, the
 * listener starts a command, the command writes a file. Tests that sleep a fixed
 * interval and then read that file are racing the write — they pass on an idle
 * machine and fail under load. These helpers poll the OBSERVABLE RESULT instead,
 * so a test waits exactly as long as the work takes and never longer.
 *
 * @module dsh-compat-adapter/test/helpers/wait
 */

import { existsSync, readFileSync } from 'node:fs'

/** Default ceiling for a poll; generous because CI machines can be slow. */
const DEFAULT_TIMEOUT_MS = 5000

/**
 * Poll until `probe` returns a defined value.
 *
 * @param {() => unknown} probe - returns undefined while the result is not ready.
 * @param {object} [options] - wait options.
 * @param {number} [options.timeoutMs] - ceiling in milliseconds.
 * @param {number} [options.intervalMs] - poll interval.
 * @param {string} [options.what] - description for the failure message.
 * @returns {Promise<unknown>} the first defined probe result.
 * @throws {Error} when the ceiling is reached.
 */
export async function waitFor(probe, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? 25
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = probe()
    if (last !== undefined && last !== false) return last
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms waiting for ${options.what ?? 'a result'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Read and parse a JSON trace file written by a hook, waiting until it is
 * complete. A file that exists but is still being written is NOT ready, so
 * existence alone is never treated as success.
 *
 * @param {string} path - trace file path.
 * @param {object} [options] - wait options.
 * @returns {Promise<object>} the parsed JSON body.
 */
export async function waitForJson(path, options = {}) {
  return waitFor(
    () => {
      if (!existsSync(path)) return undefined
      try {
        const text = readFileSync(path, 'utf8')
        if (text.trim() === '') return undefined
        return JSON.parse(text)
      } catch {
        return undefined
      }
    },
    { what: `a complete JSON trace at ${path}`, ...options },
  )
}

/**
 * Wait until a file exists (for tests that only need the side effect).
 *
 * @param {string} path - file path.
 * @param {object} [options] - wait options.
 * @returns {Promise<true>} resolves once the file exists.
 */
export async function waitForFile(path, options = {}) {
  await waitFor(() => (existsSync(path) ? true : undefined), { what: `file ${path}`, ...options })
  return true
}
