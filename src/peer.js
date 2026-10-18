/**
 * Lazy peer resolution.
 *
 * A bundle installed into a profile is resolved through the profile's runtime
 * interception, but its own `@deepseek-ai/*` peers live in the dsh installation.
 * Whether that resolves depends on HOW the bundle was imported (loader
 * interception vs. a plain import from a linked directory), so a top-level
 * static import of a peer is a load-time landmine: if resolution fails the whole
 * plugin fails to import and the row silently does nothing.
 *
 * This module turns every peer into a lazy, memoised import with a precise
 * failure the adapter can grade. The plugin itself therefore imports with ZERO
 * third-party specifiers — only `node:` builtins and its own relative files —
 * so it always mounts, and any missing capability becomes a visible
 * `UNSUPPORTED` result (with the real reason) instead of a vanished plugin.
 *
 * @module dsh-compat-adapter/peer
 */

/** Memoised resolutions per specifier. */
const cache = new Map()

/**
 * Import one peer package lazily.
 *
 * @param {string} specifier - bare package specifier (e.g. `@deepseek-ai/dsh-llm`).
 * @returns {Promise<object>} the module namespace.
 * @throws {Error} a diagnostic naming the package and how to repair it.
 */
export async function loadPeer(specifier) {
  const cached = cache.get(specifier)
  if (cached !== undefined) {
    if (cached.error !== undefined) throw cached.error
    return cached.namespace
  }
  try {
    const namespace = await import(specifier)
    cache.set(specifier, { namespace })
    return namespace
  } catch (cause) {
    const error = new Error(
      `dsh-compat-adapter: required DSH package ${JSON.stringify(specifier)} is not resolvable from this installation ` +
        `(${String(cause?.message ?? cause)}). The plugin mounted anyway so the rest of its service keeps working; ` +
        `the capability that needs this package is reported UNSUPPORTED until it resolves.`,
    )
    error.cause = cause
    error.peerSpecifier = specifier
    cache.set(specifier, { error })
    throw error
  }
}

/**
 * Import one peer and read a named export.
 *
 * @param {string} specifier - bare package specifier.
 * @param {string} exportName - named export to read (`default` reads the default export).
 * @returns {Promise<unknown>} the export value.
 * @throws {Error} when the package resolves but lacks the export.
 */
export async function loadPeerExport(specifier, exportName) {
  const namespace = await loadPeer(specifier)
  const value = exportName === 'default' ? namespace.default : namespace[exportName]
  if (value === undefined) {
    const error = new Error(
      `dsh-compat-adapter: ${JSON.stringify(specifier)} resolved but has no export named ${JSON.stringify(exportName)}. ` +
        'The installed DSH likely changed its surface; run `npm run check-surface` and update src/surface.js.',
    )
    error.peerSpecifier = specifier
    error.missingExport = exportName
    throw error
  }
  return value
}

/**
 * Whether one peer is currently resolvable. Used by `status()` and by
 * capability grading so a missing package is visible instead of silent.
 *
 * @param {string} specifier - bare package specifier.
 * @returns {Promise<boolean>} true when the package imports.
 */
export async function peerAvailable(specifier) {
  try {
    await loadPeer(specifier)
    return true
  } catch {
    return false
  }
}

/**
 * Test helper: forget every memoised resolution.
 *
 * @returns {void}
 */
export function resetPeerCache() {
  cache.clear()
}
