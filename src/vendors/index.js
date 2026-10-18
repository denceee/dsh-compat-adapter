/**
 * Vendor registry. Each vendor is a pure data module (no I/O, no DSH imports)
 * so the whole support matrix is testable and inspectable without a Harness.
 *
 * Adding a vendor means: create `vendors/<id>.js` exporting VENDOR, HOOKS,
 * RULES, KNOWN_EVENTS (and optionally BRIDGE_PACKAGE), then add it here and to
 * the README matrix plus tests/vendors.test.js fixture rows. An unknown vendor
 * passed to the service is an authoring error (UNKNOWN_VENDOR), never a silent
 * fallback.
 *
 * @module dsh-compat-adapter/vendors
 */

import * as claude from './claude.js'
import * as codex from './codex.js'
import * as workbuddy from './workbuddy.js'
import * as opencode from './opencode.js'
import * as copilot from './copilot.js'

/**
 * Alias table: what a preset author may write in `vendor`. Aliases are
 * explicit, not fuzzy matching — there is no filename sniffing anywhere.
 */
const VENDOR_MODULES = Object.freeze({
  claude,
  'claude-code': claude,
  cc: claude,
  codex: codex,
  'openai-codex': codex,
  workbuddy: workbuddy,
  'codebuddy': workbuddy,
  opencode: opencode,
  copilot: copilot,
  'github-copilot': copilot,
})

/** The canonical vendor ids (one per adapter module). */
export const VENDORS = Object.freeze(['claude', 'codex', 'workbuddy', 'opencode', 'copilot'])

/**
 * Resolve a declared vendor name to its adapter module.
 *
 * @param {string} vendor - the declared vendor key.
 * @returns {Readonly<object>|undefined} the adapter module, or undefined when unknown.
 */
export function vendorModule(vendor) {
  if (typeof vendor !== 'string') return undefined
  return VENDOR_MODULES[vendor.trim().toLowerCase()]
}

/**
 * Every accepted vendor spelling, for diagnostics.
 *
 * @returns {readonly string[]} sorted accepted keys.
 */
export function vendorNames() {
  return Object.freeze(Object.keys(VENDOR_MODULES).sort())
}
