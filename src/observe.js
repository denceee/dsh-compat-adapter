/**
 * Native-seam observation router.
 *
 * Some vendor events have no official bridge and no faithful DSH interception
 * seam, but they DO have an honest observe-only mapping onto a native Host
 * event (Claude Code `PreCompact` → `compaction/start` on `session/event`,
 * `SessionEnd` → `agent/disposed`). This module implements those translations.
 *
 * Design rule: observation is explicitly read-only. A command hook run from
 * this router gets the vendor payload on stdin and its stdout/stderr are
 * logged as an audit record; a blocking decision is REPORTED and ignored
 * (never silently dropped — the degradation list on the mapping says so, and
 * the log line names the attempt). Interception is not faked.
 *
 * @module dsh-compat-adapter/observe
 */

import { classifyExit } from './classify.js'
import { loadPeerExport } from './peer.js'

/** Native observation points this router knows how to construct payloads for. */
export const OBSERVE_POINTS = Object.freeze({
  /** Claude Code `PreCompact` / Codex `PreCompact` observed on the durable compaction start. */
  'compaction/start': Object.freeze({
    event: 'PreCompact',
    /** Which session event types wake the hook. */
    sessionEvents: Object.freeze(['compaction/start']),
  }),
  /** Claude Code `SessionEnd` / Codex `SessionEnd` observed when the agent leaves the registry. */
  'agent/disposed': Object.freeze({
    event: 'SessionEnd',
    /** `agent/disposed` is a Cordis event, not a session event. */
    sessionEvents: Object.freeze([]),
  }),
})

/**
 * A registered observe-only hook.
 *
 * @typedef {object} ObserveRegistration
 * @property {string} id            Registration id.
 * @property {string} vendor        Vendor key.
 * @property {string} event         Vendor event name.
 * @property {'compaction/start'|'agent/disposed'} point Native observation point.
 * @property {string} handler       Command line to run.
 * @property {number} timeoutSec    Per-run timeout (wire unit: seconds).
 */

/**
 * Build the vendor-shaped payload for one observation. Payloads are
 * deliberately minimal and honest: fields a vendor supplies that DSH cannot
 * reconstruct are present as explicit nulls, never invented.
 *
 * @param {ObserveRegistration} registration - the hook being fired.
 * @param {object} facts - observed runtime facts.
 * @param {string} [facts.sessionId] - session id.
 * @param {string} [facts.cwd] - working directory.
 * @param {Record<string, unknown>} [facts.extra] - point-specific fields.
 * @returns {Record<string, unknown>} the stdin payload object.
 */
export function buildObservePayload(registration, facts = {}) {
  const base = {
    session_id: facts.sessionId ?? '',
    transcript_path: null,
    cwd: facts.cwd ?? process.cwd(),
    hook_event_name: registration.event,
  }
  if (registration.vendor === 'codex') {
    return { ...base, ...(facts.extra ?? {}) }
  }
  return { ...base, ...(facts.extra ?? {}) }
}

/**
 * Run one observe-only hook and return its audit record. Never throws: a hook
 * that cannot run is a degraded observation, not a broken session.
 *
 * @param {object} options - run options.
 * @param {import('@deepseek-ai/dsh-shell').ShellExecutor} options.shell - shell executor (may be undefined).
 * @param {ObserveRegistration} options.registration - the hook.
 * @param {object} options.payload - stdin payload.
 * @param {string} [options.cwd] - working directory.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @param {number} options.defaultTimeoutMs - bridge default timeout.
 * @param {(line: string) => void} [options.log] - diagnostics sink.
 * @returns {Promise<{ran: boolean, event: string, decision: string, reason?: string, exitCode?: number, durationMs: number, note?: string}>} the audit record.
 */
export async function runObservedHook(options) {
  const { shell, registration, payload, cwd, signal, defaultTimeoutMs } = options
  const log = options.log ?? (() => {})
  if (shell === undefined) {
    return {
      ran: false,
      event: registration.event,
      decision: 'unavailable',
      durationMs: 0,
      note: 'ctx.shell is not mounted in this composition; an observe-only hook cannot run. The observation itself still happened.',
    }
  }
  let runHook
  try {
    runHook = await loadPeerExport('@deepseek-ai/dsh-hook-protocol', 'runHook')
  } catch (error) {
    log(`observe-only ${registration.event} hook cannot run: ${String(error?.message ?? error)}`)
    return {
      ran: false,
      event: registration.event,
      decision: 'unavailable',
      durationMs: 0,
      note: 'The DSH hook protocol package is not resolvable, so the observe-only hook command cannot be executed.',
    }
  }
  try {
    const { output, durationMs } = await runHook(
      shell,
      { command: registration.handler, timeoutSec: registration.timeoutSec },
      {
        payload,
        defaultTimeoutMs,
        ...(cwd === undefined ? {} : { cwd }),
        signal: signal ?? new AbortController().signal,
        trailingNewline: true,
        expectedEventName: registration.event,
      },
      () => performance.now(),
    )
    const decision = classifyExit(output)
    if (decision.executable) {
      log(
        `observe-only ${registration.vendor} ${registration.event} hook asked for ${decision.decision}; ` +
          `the ${registration.point} mapping is observe-only and cannot veto — decision ignored (see the capability degradations).`,
      )
    }
    return {
      ran: true,
      event: registration.event,
      decision: decision.decision,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      ...(output.exitCode === undefined ? {} : { exitCode: output.exitCode }),
      durationMs,
    }
  } catch (error) {
    log(`observe-only ${registration.event} hook failed to run: ${String(error)}`)
    return { ran: false, event: registration.event, decision: 'error', durationMs: 0, note: String(error) }
  }
}
