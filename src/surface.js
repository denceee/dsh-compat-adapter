/**
 * The DSH surface this adapter consumes, pinned by version and checked loudly.
 *
 * DSH is a developer preview: a minor release may rename a seam, change an
 * event payload, or move an export. The adapter must fail loudly instead of
 * silently adapting nothing, so every consumed surface element is listed here
 * once, with the exact package and symbol it needs, and
 * `scripts/check-surface.js` asserts all of them against the installed DSH.
 *
 * `dshVersion` is the exact runtime version this build targets. Upgrade flow:
 *   1. bump `dshVersion` (and peer ranges) after reviewing the changelog,
 *   2. run `npm run check-surface`,
 *   3. fix every red line, then run `npm test`.
 *
 * @module dsh-compat-adapter/surface
 */

/** The DSH version this adapter was authored and verified against. */
export const DSH_SURFACE = Object.freeze({
  dshVersion: '0.2.0-rc.2',
  /** Service names read through `ctx.get(...)`; each must resolve at runtime. */
  services: Object.freeze([
    'shell',
    'sessionProjections',
    'shellEnv',
    'workspaceChanges',
  ]),
  /** Host events the adapter listens on or relies on the bridges listening to. */
  events: Object.freeze([
    'agent/created',
    'agent/disposed',
    'session/event',
    'tools/pre-execute',
    'tools/post-execute',
    'agent/pre-step',
    'agent/turn-stopping',
    'subagent/start',
    'subagent/end',
    'agent/error',
    'settings/document-updated',
    'approval/request',
    'session/created',
    'agent/status',
    'agent/inbox/inserted',
    'workspace/changes',
  ]),
  /** DSH packages whose exports the adapter imports, with the symbols it uses. */
  packages: Object.freeze({
    '@deepseek-ai/cordis': Object.freeze(['Context', 'Service']),
    '@deepseek-ai/dsh-hook-protocol': Object.freeze([
      'matchesMatcher',
      'matcherDiagnostic',
      'parseHookOutput',
      'runHook',
      'mergeHookOutputs',
      'createDetachedRuns',
      'DEFAULT_HOOK_TIMEOUT_MS',
    ]),
    '@deepseek-ai/dsh-hooks-claude-code': Object.freeze(['apply', 'inject', 'Config']),
    '@deepseek-ai/dsh-hooks-codex': Object.freeze(['apply', 'inject', 'Config']),
    '@deepseek-ai/dsh-llm': Object.freeze(['createUserMessage']),
    '@deepseek-ai/schemastery': Object.freeze(['default']),
  }),
  /**
   * Session event types the adapter consumes from the durable log. Each must be
   * declaration-merged into `SessionEventMap` by an installed package; the
   * checker verifies the event name is declared by a shipped package.
   */
  sessionEvents: Object.freeze([
    'compaction/start',
    'compaction/summary',
    'compaction/end',
  ]),
  /**
   * Honest scope statement for the `dshVersion` pin: what a version mismatch
   * actually endangers. Kept here so the README and the activation warning
   * quote one source.
   */
  /**
   * Vendors deliberately adapted WITHOUT an official DSH bridge. The surface
   * check asserts no `dsh-hooks-copilot` package appears: if DSH ever ships one,
   * this adapter's hand-written translation layer becomes redundant and the
   * maintainer must review these rows instead of silently running two bridges.
   */
  bridgeLessVendors: Object.freeze(['copilot']),
  pinReason:
    'Bridges, event payloads and service methods in this adapter are pinned to this exact DSH build; a different build may rename a seam and make an adaptation silently wrong.',
})

/**
 * Assert that a consumed service/provider is present, throwing a diagnostic
 * that names the missing DSH surface element rather than failing later with a
 * generic TypeError inside a listener.
 *
 * @param {unknown} value - the resolved service or symbol.
 * @param {string} what - human-readable surface element name.
 * @param {string} where - where the requirement comes from (package/module).
 * @returns {void}
 */
export function requireSurface(value, what, where) {
  if (value === undefined || value === null) {
    throw new Error(
      `dsh-compat-adapter: DSH surface changed — ${what} is missing (required by ${where}). ` +
        `This adapter targets DSH ${DSH_SURFACE.dshVersion}; run \`npm run check-surface\` against the installed DSH and update src/surface.js.`,
    )
  }
}

/**
 * Format the loud version-mismatch diagnostic used at activation time.
 *
 * @param {string} actual - runtime DSH version.
 * @param {string} expected - version this build targets.
 * @returns {string} the diagnostic.
 */
export function versionMismatchMessage(actual, expected) {
  return (
    `dsh-compat-adapter: targets DSH ${expected} but the running Harness reports ${actual}. ${DSH_SURFACE.pinReason} ` +
    'Run `npm run check-surface` and update src/surface.js + peerDependencies before relying on it.'
  )
}
