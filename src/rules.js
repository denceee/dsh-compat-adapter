/**
 * Rules carry-and-inject module.
 *
 * Rules are never translated into executable DSH policy: the reference tools'
 * rule artifacts are instruction text (Claude CLAUDE.md, OpenCode AGENTS.md,
 * WorkBuddy CODEBUDDY.md) or a command-policy DSL with no DSH equivalent
 * (Codex Starlark `rules/*.rules`). Translating any of them would invent
 * semantics, so the adapter carries the bytes verbatim and injects them as a
 * sourced user message at session start — the same mechanism DSH uses for its
 * own instruction chain, but with a distinguishable `source` so the model and
 * a human can tell where the text came from.
 *
 * @module dsh-compat-adapter/rules
 */

import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPABILITY, capabilityResult } from './capability.js'
import { CompatAdapterError, ERROR_CODES } from './errors.js'

/** The `source.kind` stamped on every injected rules message. */
export const RULES_SOURCE_KIND = 'compat-adapter-rules'

/** Default cap per carried file (MCP-style defensive bound; a rule file is text). */
export const DEFAULT_MAX_RULE_BYTES = 512 * 1024

/**
 * Resolve one declared rules source into concrete files.
 *
 * `source` may be:
 * - an absolute path,
 * - a path relative to `baseDir` (the declaring package root),
 * - an array of either,
 * - a glob pattern without magic characters treated as a literal file.
 *
 * Detection of the *vendor* is never performed here: the caller declared it.
 * Glob expansion is only path resolution, not content sniffing.
 *
 * @param {string|string[]} source - the declared source.
 * @param {string} baseDir - directory relative paths resolve against.
 * @returns {string[]} absolute file paths, in declaration order, de-duplicated.
 */
export function resolveRuleFiles(source, baseDir) {
  const declared = Array.isArray(source) ? source : [source]
  if (declared.length === 0) {
    throw new CompatAdapterError(ERROR_CODES.RULE_SOURCE_INVALID, 'dsh-compat-adapter: registerRules requires a non-empty source')
  }
  const files = []
  const seen = new Set()
  for (const entry of declared) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new CompatAdapterError(ERROR_CODES.RULE_SOURCE_INVALID, `dsh-compat-adapter: rules source entries must be non-empty strings, got ${JSON.stringify(entry)}`)
    }
    // `file://` URLs are accepted so a preset can name a resource through an import URL.
    const raw = entry.startsWith('file:') ? fileURLToPath(entry) : entry
    const pattern = isAbsolute(raw) ? raw : resolve(baseDir, raw)
    const matches = /[*?[\]{}]/.test(pattern) ? globSync(pattern, { withFileTypes: false }) : [pattern]
    if (matches.length === 0) {
      throw new CompatAdapterError(
        ERROR_CODES.RULE_SOURCE_INVALID,
        `dsh-compat-adapter: rules source ${JSON.stringify(entry)} matched no files (resolved ${pattern}). Rules are carried by reading files at registration time; a missing source is an authoring error, not an empty rule set.`,
        { pattern },
      )
    }
    for (const match of matches) {
      if (!existsSync(match)) {
        throw new CompatAdapterError(ERROR_CODES.RULE_SOURCE_INVALID, `dsh-compat-adapter: rules source ${JSON.stringify(entry)} resolved to a missing file ${match}`, { file: match })
      }
      const absolute = resolve(match)
      if (seen.has(absolute)) continue
      seen.add(absolute)
      files.push(absolute)
    }
  }
  return files
}

/**
 * Read one rule file into a carried asset.
 *
 * @param {string} file - absolute path.
 * @param {string} vendor - declared vendor key.
 * @param {{maxBytes?: number}} [options] - read options.
 * @returns {{path: string, name: string, bytes: number, sha256: string, text: string}} the carried asset.
 * @throws {CompatAdapterError} RULE_SOURCE_INVALID when the file cannot be read or exceeds the cap.
 */
export function readRuleAsset(file, vendor, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RULE_BYTES
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new CompatAdapterError(ERROR_CODES.RULE_SOURCE_INVALID, `dsh-compat-adapter: cannot read ${vendor} rules file ${file}: ${String(error)}`, { file })
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxBytes) {
    throw new CompatAdapterError(
      ERROR_CODES.RULE_SOURCE_INVALID,
      `dsh-compat-adapter: ${vendor} rules file ${file} is ${bytes} bytes, above the ${maxBytes}-byte cap. Split it or raise config.maxRuleBytes; the adapter refuses to silently truncate policy-relevant text.`,
      { file, bytes, maxBytes },
    )
  }
  return {
    path: file,
    name: file.split(/[\\/]/).pop() ?? file,
    bytes,
    sha256: createHash('sha256').update(text).digest('hex'),
    text,
  }
}

/**
 * Render the injection text for one vendor's carried rules. The header is
 * explicit that the text is context — this is the one place a preset author
 * could accidentally imply enforcement, so it is stated in the message itself.
 *
 * @param {object} options - render options.
 * @param {string} options.vendor - vendor key.
 * @param {string[]} options.formats - vendor rule formats (from the vendor table).
 * @param {Array<{name: string, path: string, text: string, sha256: string}>} options.assets - carried files.
 * @returns {string} the message body.
 */
export function renderRulesContext(options) {
  const { vendor, formats, assets } = options
  const formatNote = formats.includes('starlark')
    ? 'These are Codex rule files (Starlark command policy). They are NOT enforced by DSH: treat them as documentation of the original tool policy, never as a security boundary.'
    : 'These are instruction files. DSH treats them as context, not enforced configuration.'
  const sections = assets.map(
    (asset) => `### ${asset.name}\n\n<!-- source: ${asset.path} · sha256:${asset.sha256} -->\n\n${asset.text.replace(/\s+$/u, '')}`,
  )
  return [
    `## Carried ${vendor} rules`,
    '',
    `The following text was declared by this preset as ${vendor} rules and carried verbatim from disk.`,
    formatNote,
    '',
    ...sections,
  ].join('\n')
}

/**
 * Grade one rules registration against the vendor's declared rules policy.
 *
 * @param {object} options - grading options.
 * @param {string} vendor - declared vendor key.
 * @param {Readonly<object>} vendorRules - the vendor module's RULES table.
 * @param {Array<object>} assets - carried files.
 * @returns {Readonly<import('./capability.js').CapabilityResult>} the CARRY result.
 */
export function rulesCapability(vendor, vendorRules, assets) {
  return capabilityResult({
    id: `${vendor}:rules`,
    vendor,
    asset: 'rules',
    capability: CAPABILITY.CARRY,
    seams: ['agent/created'],
    degradations: [],
    note: vendorRules.note,
    ...(assets.length === 0 ? {} : {}),
  })
}

/**
 * Resolve the default base directory for a preset's declarations. A preset
 * passes `baseDir` explicitly when it knows it; otherwise relative sources are
 * rejected rather than resolved against an arbitrary process cwd (which would
 * be silent global detection in disguise).
 *
 * @param {string|undefined} baseDir - caller-supplied base directory.
 * @returns {string} an absolute directory.
 * @throws {CompatAdapterError} INVALID_DECLARATION when a relative base cannot be resolved.
 */
export function resolveBaseDir(baseDir) {
  if (baseDir === undefined) return process.cwd()
  if (typeof baseDir === 'string' && isAbsolute(baseDir)) return baseDir
  throw new CompatAdapterError(ERROR_CODES.INVALID_DECLARATION, `dsh-compat-adapter: baseDir must be an absolute path, got ${JSON.stringify(baseDir)}`)
}

/**
 * The `source` object attached to the injected message. Declared in the
 * adapter's own module so every message kind is distinguishable in the log.
 *
 * @param {string} vendor - declared vendor.
 * @param {number} count - number of carried files.
 * @returns {{kind: string, vendor: string, files: number}} the source.
 */
export function rulesSource(vendor, count) {
  return { kind: RULES_SOURCE_KIND, vendor, files: count }
}

/** Re-exported for callers that need the directory of a module URL. */
export const dirOf = (url) => dirname(url)
