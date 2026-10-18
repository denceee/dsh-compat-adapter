/**
 * The static support matrix.
 *
 * One table per vendor family, derived directly from the vendor adapter
 * modules (never hand-maintained): a README section and a test both render
 * this module, so documentation cannot drift from code and no claim can be
 * broader than the adapter tables.
 *
 * @module dsh-compat-adapter/matrix
 */

import { CAPABILITY, CAPABILITY_ORDER } from './capability.js'
import { VENDORS, vendorModule } from './vendors/index.js'
import { OBSERVE_POINTS } from './observe.js'
import { NATIVE_TRANSLATIONS } from './translate.js'

/** Runtime surfaces that are explicitly out of scope, with the vendor-specific reason. */
export const RUNTIME_SURFACES = Object.freeze({
  claude: Object.freeze({
    capability: CAPABILITY.UNSUPPORTED,
    reason:
      'Claude Code plugin runtimes (plugin hooks that are JS modules, MCP-provided tools) are not command hooks; only the JSON command-hook config is adapted.',
  }),
  codex: Object.freeze({
    capability: CAPABILITY.UNSUPPORTED,
    reason: 'Codex has no TypeScript plugin runtime in scope; only its command hooks.json and rules files are adapted.',
  }),
  workbuddy: Object.freeze({
    capability: CAPABILITY.UNSUPPORTED,
    reason:
      'WorkBuddy/CodeBuddy plugin runtimes (IDE extensions, MCP servers, workflow scripts) are out of scope: this adapter adapts JSON hooks + rules text only.',
  }),
  opencode: Object.freeze({
    capability: CAPABILITY.UNSUPPORTED,
    reason:
      'OpenCode plugins ARE TypeScript callbacks in a co-resident runtime (tool.execute.before/after, event, shell.env). Porting them means embedding a foreign plugin runtime in the DSH Host — explicitly out of scope; only OpenCode AGENTS.md/instructions text is carried.',
  }),
  copilot: Object.freeze({
    capability: CAPABILITY.UNSUPPORTED,
    reason:
      'Copilot’s SDK hook API is a programmatic callback interface (Node/Python/Go/.NET/Java) bound to a CopilotClient session. This adapter adapts Copilot’s JSON command-hook config and instruction files only; an in-process Copilot SDK callback cannot be carried into the DSH Host.',
  }),
})

/** Grading legend used by the rendered matrix and README. */
export const CAPABILITY_LEGEND = Object.freeze({
  DIRECT: 'a 1:1 DSH seam exists; semantics preserved verbatim.',
  ADAPTED: 'a DSH seam exists; the listed degradations are the losses.',
  CARRY: 'no general mapping; carried verbatim and injected as context (never executable policy).',
  UNSUPPORTED: 'no faithful mapping; registration is rejected with the reason below.',
})

/** Marker opening the generated matrix block in every README. */
export const MATRIX_START = '<!-- MATRIX:START -->'

/** Marker closing the generated matrix block in every README. */
export const MATRIX_END = '<!-- MATRIX:END -->'

/**
 * Every README that embeds the generated matrix, in the order the writer
 * updates them. The drift test iterates this same list, so adding a translated
 * README automatically makes it subject to the no-overclaim guarantee instead
 * of silently escaping it.
 */
export const README_FILES = Object.freeze(['README.md', 'README.en.md'])

/**
 * Build one vendor's matrix row set.
 *
 * @param {string} vendor - canonical vendor id.
 * @returns {object} the vendor matrix.
 */
export function vendorMatrix(vendor) {
  const module = vendorModule(vendor)
  if (module === undefined) throw new Error(`dsh-compat-adapter: no adapter for vendor ${JSON.stringify(vendor)}`)
  const events = Object.entries(module.HOOKS).map(([event, mapping]) => ({
    vendor: module.VENDOR,
    event,
    capability: mapping.capability,
    route: mapping.route,
    seams: [...(mapping.seams ?? [])],
    degradations: [...(mapping.degradations ?? [])],
    ...(mapping.bridge === undefined ? {} : { bridge: mapping.bridge }),
    ...(mapping.point === undefined ? {} : { point: mapping.point }),
    ...(mapping.reason === undefined ? {} : { reason: mapping.reason }),
    ...(mapping.note === undefined ? {} : { note: mapping.note }),
  }))
  return {
    vendor: module.VENDOR,
    bridgePackage: module.BRIDGE_PACKAGE ?? null,
    hooks: events,
    supported: events.filter((entry) => entry.capability === CAPABILITY.DIRECT || entry.capability === CAPABILITY.ADAPTED).length,
    unsupported: events.filter((entry) => entry.capability === CAPABILITY.UNSUPPORTED).length,
    rules: { capability: module.RULES.capability, formats: [...module.RULES.formats], note: module.RULES.note },
    runtime: RUNTIME_SURFACES[module.VENDOR],
  }
}

/**
 * Build the complete matrix for every vendor, in canonical order.
 *
 * @returns {readonly object[]} frozen vendor matrices.
 */
export function buildMatrix() {
  return Object.freeze(VENDORS.map((vendor) => Object.freeze(vendorMatrix(vendor))))
}

/**
 * Every event name across vendors, grouped by capability grade. Used by tests
 * to assert that unsupported names are explicit rather than absent.
 *
 * @param {readonly object[]} [matrix] - matrix to inspect; defaults to {@link buildMatrix}.
 * @returns {Record<string, Array<{vendor: string, event: string}>>} grouped entries.
 */
export function groupByCapability(matrix = buildMatrix()) {
  const grouped = Object.fromEntries(CAPABILITY_ORDER.map((grade) => [grade, []]))
  for (const vendor of matrix) {
    for (const event of vendor.hooks) {
      grouped[event.capability].push({ vendor: event.vendor, event: event.event })
    }
  }
  return grouped
}

/**
 * Render the matrix as Markdown (README and `npm run matrix` use this exact
 * output; the README test compares them so the document cannot overclaim).
 *
 * @returns {string} Markdown tables.
 */
export function renderMatrixMarkdown() {
  const lines = []
  lines.push('### Hooks: vendor event → DSH seam')
  lines.push('')
  lines.push('| Vendor | Event | Capability | Route | DSH seam(s) | Losses / reason |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const vendor of buildMatrix()) {
    for (const event of vendor.hooks) {
      const detail = event.capability === CAPABILITY.UNSUPPORTED ? event.reason ?? '' : (event.degradations ?? []).join('; ')
      const seamText = event.seams.length === 0 ? '—' : event.seams.join(', ')
      const routeText =
        event.route === 'official-bridge'
          ? `official bridge (${event.bridge})`
          : event.route === 'builtin-bridge'
            ? `bridge built by this plugin (${event.bridge})`
            : event.route === 'native-seam'
            ? `native seam, observe-only (\`${event.point}\`)`
            : event.route === 'native-translate'
              ? `native translation (\`${event.point}\`)`
              : 'rejected'
      lines.push(`| ${event.vendor} | \`${event.event}\` | ${event.capability} | ${routeText} | ${seamText} | ${escapeCell(detail)} |`)
    }
  }
  lines.push('')
  lines.push('### Rules: carried and injected, never executed')
  lines.push('')
  lines.push('| Vendor | Capability | Accepted formats | Default on-disk sources |')
  lines.push('| --- | --- | --- | --- |')
  for (const vendor of buildMatrix()) {
    lines.push(`| ${vendor.vendor} | ${vendor.rules.capability} | ${vendor.rules.formats.join(', ')} | ${escapeCell(vendor.rules.note)} |`)
  }
  lines.push('')
  lines.push('### Vendor plugin runtimes: out of scope')
  lines.push('')
  lines.push('| Vendor | Capability | Reason |')
  lines.push('| --- | --- | --- |')
  for (const vendor of buildMatrix()) {
    lines.push(`| ${vendor.vendor} | ${vendor.runtime.capability} | ${escapeCell(vendor.runtime.reason)} |`)
  }
  lines.push('')
  lines.push('### Native translation points used by native-translate events')
  lines.push('')
  lines.push('These are REAL interceptions: the hook decision reaches DSH. Vendors with an official bridge never use them.')
  lines.push('')
  lines.push('| Native point | DSH seam | Seam mode | Produces |')
  lines.push('| --- | --- | --- | --- |')
  for (const [point, descriptor] of Object.entries(NATIVE_TRANSLATIONS)) {
    lines.push(`| \`${point}\` | \`${descriptor.seam}\` | ${descriptor.mode} | ${descriptor.produces} |`)
  }
  lines.push('')
  lines.push('### Native observation points used by native-seam events')
  lines.push('')
  lines.push('| Native point | Vendor event | Wakes on |')
  lines.push('| --- | --- | --- |')
  for (const [point, descriptor] of Object.entries(OBSERVE_POINTS)) {
    lines.push(`| \`${point}\` | ${descriptor.event} | ${descriptor.sessionEvents.length === 0 ? 'Cordis event' : descriptor.sessionEvents.map((name) => `\`${name}\``).join(', ')} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * One Markdown table cell: pipes escaped, newlines flattened.
 *
 * @param {string} text - raw cell text.
 * @returns {string} escaped text.
 */
function escapeCell(text) {
  return String(text).replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ')
}
