/**
 * Capability grading vocabulary shared by every vendor adapter and by the
 * public `registerHook` / `registerRules` results.
 *
 * Four grades, never a boolean:
 * - `DIRECT`      a 1:1 DSH seam exists and semantics are preserved verbatim.
 * - `ADAPTED`     a DSH seam exists, but one or more fields/behaviors are
 *                 approximated; `degradations[]` states each loss.
 * - `CARRY`       no general mapping exists; the asset is carried verbatim and
 *                 injected where DSH has a text-only seam. It never becomes
 *                 executable policy.
 * - `UNSUPPORTED` no faithful mapping; the registration is rejected with a
 *                 `reason`. Fail-closed: an unsupported asset is never silently
 *                 downgraded into a working-looking no-op.
 *
 * @module dsh-compat-adapter/capability
 */

/** The four capability grades. */
export const CAPABILITY = Object.freeze({
  DIRECT: 'DIRECT',
  ADAPTED: 'ADAPTED',
  CARRY: 'CARRY',
  UNSUPPORTED: 'UNSUPPORTED',
});

/** Every capability grade, most faithful first. */
export const CAPABILITY_ORDER = Object.freeze([
  CAPABILITY.DIRECT,
  CAPABILITY.ADAPTED,
  CAPABILITY.CARRY,
  CAPABILITY.UNSUPPORTED,
]);

/**
 * @typedef {object} CapabilityResult
 * @property {string} id           Stable registration id.
 * @property {string} vendor       Normalized vendor key.
 * @property {'hook'|'rules'|'runtime'} asset Asset family.
 * @property {string} capability   One of {@link CAPABILITY}.
 * @property {string} [event]      Hook event name (hooks only).
 * @property {string[]} [seams]    DSH seams the asset routes to.
 * @property {string[]} [degradations] Known semantic losses (ADAPTED).
 * @property {string} [reason]     Why the asset is unsupported (UNSUPPORTED).
 * @property {string} [note]       Human-facing carry/injection note (CARRY).
 */

/** True when DSH will actually execute the asset. */
export function isExecutable(capability) {
  return capability === CAPABILITY.DIRECT || capability === CAPABILITY.ADAPTED;
}

/** True when the asset is carried (injected as text) but not executable policy. */
export function isCarried(capability) {
  return capability === CAPABILITY.CARRY;
}

/**
 * Validate and freeze one capability result. Throws only for a programming
 * error (unknown grade or a missing required explanation), never because an
 * asset is unsupported.
 *
 * @param {CapabilityResult} result - the result to validate.
 * @returns {Readonly<CapabilityResult>} the frozen result.
 */
export function capabilityResult(result) {
  if (!CAPABILITY_ORDER.includes(result.capability)) {
    throw new TypeError(`dsh-compat-adapter: unknown capability ${JSON.stringify(result.capability)}`);
  }
  if (result.capability === CAPABILITY.UNSUPPORTED && !result.reason) {
    throw new TypeError('dsh-compat-adapter: an UNSUPPORTED result must carry a reason');
  }
  if (result.capability === CAPABILITY.ADAPTED && !(result.degradations?.length > 0)) {
    throw new TypeError('dsh-compat-adapter: an ADAPTED result must list at least one degradation');
  }
  return Object.freeze({
    ...result,
    seams: Object.freeze([...(result.seams ?? [])]),
    degradations: Object.freeze([...(result.degradations ?? [])]),
  });
}
