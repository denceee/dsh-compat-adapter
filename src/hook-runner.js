/**
 * Shared command-hook runner.
 *
 * One thin wrapper over the DSH hook protocol's `runHook`, used by both the
 * observe-only router and the Copilot native translator. It exists so the
 * protocol package is resolved LAZILY in exactly one place: a bundle installed
 * into a profile cannot rely on a top-level peer import (see `src/peer.js`), and
 * duplicating the lazy lookup would let the two callers drift.
 *
 * @module dsh-compat-adapter/hook-runner
 */

import { loadPeerExport } from './peer.js'

/**
 * Run one command hook through `ctx.shell`.
 *
 * @param {object} options - invocation options.
 * @param {import('@deepseek-ai/dsh-shell').ShellExecutor|undefined} options.shell - shell executor (undefined → cannot run).
 * @param {string} options.command - the hook command line.
 * @param {number|undefined} options.timeoutSec - per-hook timeout, seconds.
 * @param {unknown} options.payload - stdin payload object.
 * @param {string|undefined} options.cwd - working directory.
 * @param {AbortSignal|undefined} options.signal - cancellation.
 * @param {number} options.defaultTimeoutMs - default timeout in ms.
 * @param {boolean} options.trailingNewline - whether to append a newline to stdin.
 * @param {string|undefined} options.expectedEventName - event name for strict output parsing.
 * @returns {Promise<{output: import('@deepseek-ai/dsh-hook-protocol').HookOutput, durationMs: number}|undefined>} the result, or undefined when it cannot run.
 */
export async function runHookProtocol(options) {
  if (options.shell === undefined) return undefined
  let runHook
  try {
    runHook = await loadPeerExport('@deepseek-ai/dsh-hook-protocol', 'runHook')
  } catch {
    return undefined
  }
  const { output, durationMs } = await runHook(
    options.shell,
    {
      command: options.command,
      ...(options.timeoutSec === undefined ? {} : { timeoutSec: options.timeoutSec }),
    },
    {
      payload: options.payload,
      defaultTimeoutMs: options.defaultTimeoutMs,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      signal: options.signal ?? new AbortController().signal,
      trailingNewline: options.trailingNewline,
      ...(options.expectedEventName === undefined ? {} : { expectedEventName: options.expectedEventName }),
    },
    () => performance.now(),
  )
  return { output, durationMs }
}
