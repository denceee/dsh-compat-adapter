/**
 * Shared helpers for building vendor hook tables. A vendor adapter is a pure
 * data module: it declares which of the vendor's hook events map to which DSH
 * seam, at which capability grade. It never performs I/O and never imports
 * DSH packages, so the whole matrix is unit-testable without a Harness.
 *
 * @module dsh-compat-adapter/vendors/shared
 */

import { CAPABILITY, capabilityResult } from '../capability.js'

/**
 * One hook-event mapping. `route` says how the adapter realizes it:
 * - `official-bridge`: the event is handed to a DSH official bridge
 *   (`dsh-hooks-claude-code` / `dsh-hooks-codex`) that owns payloads, matcher
 *   execution, and decision mapping.
 * - `native-seam`: the event has no official-bridge coverage, so the adapter
 *   translates it directly onto a native Host seam (and states the losses).
 * - `unsupported`: no faithful mapping exists.
 *
 * @typedef {object} HookMapping
 * @property {string} capability    DIRECT | ADAPTED | UNSUPPORTED.
 * @property {string} [bridge]      Official bridge key ('claude' | 'codex') when route is official-bridge.
 * @property {string[]} [seams]     DSH event/service seam names the hook programs against.
 * @property {string[]} [degradations] Semantic losses (required for ADAPTED).
 * @property {string} [reason]      Why unsupported (required for UNSUPPORTED).
 * @property {string} [note]        Extra author-facing guidance.
 */

/**
 * Build one official-bridge mapping.
 *
 * @param {object} options - mapping options.
 * @param {'claude'|'codex'} options.bridge - owning official bridge.
 * @param {string[]} options.seams - DSH seams the bridge programs against.
 * @param {string[]} options.degradations - semantic losses of this event through that bridge.
 * @returns {Readonly<HookMapping>} frozen mapping.
 */
export function bridged(options) {
  return Object.freeze({
    capability: CAPABILITY.ADAPTED,
    route: 'official-bridge',
    bridge: options.bridge,
    seams: Object.freeze([...options.seams]),
    degradations: Object.freeze([...options.degradations]),
    ...(options.note === undefined ? {} : { note: options.note }),
  })
}

/**
 * Build one native-seam mapping the adapter itself OBSERVES.
 *
 * Observation is read-only: the hook runs for its audit/telemetry effect and a
 * blocking decision it attempts is logged and ignored. Used for lifecycle
 * moments where DSH has no cancellable seam (compaction start, agent disposal).
 *
 * @param {object} options - mapping options.
 * @param {string} options.point - the native observation point (keys of `OBSERVE_POINTS`).
 * @param {string[]} options.seams - native DSH seams the observation rides on.
 * @param {string[]} options.degradations - semantic losses.
 * @param {string} [options.note] - extra author-facing guidance.
 * @returns {Readonly<HookMapping>} frozen mapping.
 */
export function nativeSeam(options) {
  return Object.freeze({
    capability: CAPABILITY.ADAPTED,
    route: 'native-seam',
    point: options.point,
    seams: Object.freeze([...options.seams]),
    degradations: Object.freeze([...options.degradations]),
    ...(options.note === undefined ? {} : { note: options.note }),
  })
}

/**
 * Build one native mapping the adapter TRANSLATES into a real interception.
 *
 * Unlike {@link nativeSeam}, the hook's decision reaches DSH: a deny becomes a
 * `PreToolDecision`, injected context becomes a real message, a blocking stop
 * forces another turn. Used for vendors with no official bridge whose hook
 * contract this adapter re-implements on purpose.
 *
 * @param {object} options - mapping options.
 * @param {string} options.point - the translation point (keys of `NATIVE_TRANSLATIONS`).
 * @param {string[]} options.seams - native DSH seams the translation uses.
 * @param {string[]} options.degradations - semantic losses.
 * @param {string} [options.note] - extra author-facing guidance.
 * @returns {Readonly<HookMapping>} frozen mapping.
 */
export function nativeTranslate(options) {
  return Object.freeze({
    capability: CAPABILITY.ADAPTED,
    route: 'native-translate',
    point: options.point,
    seams: Object.freeze([...options.seams]),
    degradations: Object.freeze([...options.degradations]),
    ...(options.note === undefined ? {} : { note: options.note }),
  })
}

/**
 * Build one unmappable event entry.
 *
 * @param {string} reason - exact reason the event cannot be mapped.
 * @returns {Readonly<HookMapping>} frozen mapping.
 */
export function unsupported(reason) {
  return Object.freeze({
    capability: CAPABILITY.UNSUPPORTED,
    route: 'unsupported',
    seams: Object.freeze([]),
    reason,
  })
}

/**
 * The sanctioned blocking contract for command hooks. This adapter, its tests,
 * and every generated example express blocking through stdout
 * `hookSpecificOutput.permissionDecision` (`deny` / `ask`) with exit code 0.
 * Exit code 2 is documented by the reference tools but is not dependable
 * through the 0.2.0-rc.2 bridges (it can be recorded as `decision: 'pass'` and
 * let the tool through), so the adapter never relies on it for its own
 * decisions and does not generate exit-2 handlers.
 *
 * @param {object} options - blocking output options.
 * @param {string} options.event - hook event name (`PreToolUse`, …).
 * @param {'allow'|'deny'|'ask'} options.decision - permission decision.
 * @param {string} [options.reason] - human-readable reason shown to the model.
 * @param {string} [options.additionalContext] - extra context for the model.
 * @returns {string} the exact stdout JSON a hook must print (then exit 0).
 */
export function permissionDecisionOutput(options) {
  if (!['allow', 'deny', 'ask'].includes(options.decision)) {
    throw new TypeError(`dsh-compat-adapter: invalid permissionDecision ${JSON.stringify(options.decision)}`)
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: options.event,
      permissionDecision: options.decision,
      ...(options.reason === undefined ? {} : { permissionDecisionReason: options.reason }),
      ...(options.additionalContext === undefined ? {} : { additionalContext: options.additionalContext }),
    },
  })
}

/**
 * Freeze a vendor's complete hook table and validate every entry's grade.
 *
 * @param {string} vendor - normalized vendor key.
 * @param {Record<string, HookMapping>} hooks - event name to mapping.
 * @returns {Readonly<Record<string, Readonly<HookMapping>>>} frozen table.
 */
export function freezeHookTable(vendor, hooks) {
  const frozen = {}
  for (const [event, mapping] of Object.entries(hooks)) {
    // Validate the grade via capabilityResult so a malformed ADAPTED/UNSUPPORTED
    // entry fails at import time (tests catch it before a profile ever mounts).
    capabilityResult({
      id: `${vendor}:hook:${event}`,
      vendor,
      asset: 'hook',
      capability: mapping.capability,
      event,
      seams: mapping.seams,
      degradations: mapping.degradations,
      reason: mapping.reason,
    })
    if (mapping.route === 'native-seam' && typeof mapping.point !== 'string') {
      throw new TypeError(`dsh-compat-adapter: ${vendor} ${event} is a native-seam mapping without an observation point`)
    }
    if (mapping.route === 'native-translate' && typeof mapping.point !== 'string') {
      throw new TypeError(`dsh-compat-adapter: ${vendor} ${event} is a native-translate mapping without a translation point`)
    }
    frozen[event] = mapping
  }
  return Object.freeze(frozen)
}
