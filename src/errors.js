/**
 * Typed errors for authoring mistakes. A vendor asset that is merely
 * unportable is NOT an error — it returns an UNSUPPORTED capability result.
 * An error means the declaration itself cannot be processed (unknown vendor,
 * malformed handler, missing rule source), which must fail loudly instead of
 * silently adapting nothing.
 *
 * @module dsh-compat-adapter/errors
 */

/** Stable error codes; tests and preset authors may branch on them. */
export const ERROR_CODES = Object.freeze({
  UNKNOWN_VENDOR: 'UNKNOWN_VENDOR',
  UNKNOWN_EVENT: 'UNKNOWN_EVENT',
  INVALID_DECLARATION: 'INVALID_DECLARATION',
  INVALID_HANDLER: 'INVALID_HANDLER',
  INVALID_MATCHER: 'INVALID_MATCHER',
  DUPLICATE_HOOK: 'DUPLICATE_HOOK',
  DUPLICATE_RULE: 'DUPLICATE_RULE',
  RULE_SOURCE_INVALID: 'RULE_SOURCE_INVALID',
  BRIDGE_UNAVAILABLE: 'BRIDGE_UNAVAILABLE',
  MOUNT_FAILED: 'MOUNT_FAILED',
  ADAPTER_DISPOSED: 'ADAPTER_DISPOSED',
  SURFACE_MISSING: 'SURFACE_MISSING',
});

/** One authoring/installation error with a stable code and diagnostic details. */
export class CompatAdapterError extends Error {
  /**
   * @param {string} code - one of {@link ERROR_CODES}.
   * @param {string} message - the diagnostic, written for a preset author.
   * @param {Record<string, unknown>} [details] - structured context (e.g. supported event names).
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CompatAdapterError';
    this.code = code;
    this.details = details;
  }
}
