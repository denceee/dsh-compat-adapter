/**
 * Rules: carry-and-inject semantics.
 *
 * Rules are the second half of the task scope, and the one place where a
 * plausible-looking implementation could overclaim: translation of another
 * agent's rule file into DSH policy would be an invention. These tests pin the
 * carry semantics (verbatim bytes, content hash, no execution) and the
 * fail-loud behavior for missing/oversized sources.
 *
 * @module dsh-compat-adapter/test/rules.test
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CAPABILITY } from '../src/capability.js'
import { CompatAdapterError } from '../src/errors.js'
import {
  DEFAULT_MAX_RULE_BYTES,
  RULES_SOURCE_KIND,
  readRuleAsset,
  renderRulesContext,
  resolveBaseDir,
  resolveRuleFiles,
  rulesCapability,
  rulesSource,
} from '../src/rules.js'
import * as claude from '../src/vendors/claude.js'
import * as codex from '../src/vendors/codex.js'

/**
 * Create a throwaway project directory with the given files.
 *
 * @param {Record<string, string>} files - relative path → content.
 * @returns {string} the temporary project root.
 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-rules-'))
  for (const [relative, content] of Object.entries(files)) {
    const full = join(root, relative)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return root
}

test('resolves literal files, directories of rules and globs', () => {
  const root = fixture({
    'CLAUDE.md': '# project rules\n',
    '.claude/rules/api.md': '# api rules\n',
    '.claude/rules/db.md': '# db rules\n',
  })
  assert.deepEqual(resolveRuleFiles('CLAUDE.md', root), [join(root, 'CLAUDE.md')])
  assert.deepEqual(resolveRuleFiles('.claude/rules/*.md', root).sort(), [
    join(root, '.claude/rules/api.md'),
    join(root, '.claude/rules/db.md'),
  ])
  const combined = resolveRuleFiles(['CLAUDE.md', '.claude/rules/*.md'], root)
  assert.equal(combined.length, 3)
  // De-duplication: the same file declared twice is carried once.
  assert.equal(resolveRuleFiles(['CLAUDE.md', 'CLAUDE.md'], root).length, 1)
})

test('a missing rule source is an authoring error, not an empty carry', () => {
  const root = fixture({ 'CLAUDE.md': '# rules\n' })
  assert.throws(
    () => resolveRuleFiles('MISSING.md', root),
    (error) => error instanceof CompatAdapterError && error.code === 'RULE_SOURCE_INVALID',
  )
  assert.throws(
    () => resolveRuleFiles('.claude/rules/*.md', root),
    (error) => error instanceof CompatAdapterError && /matched no files/u.test(error.message),
  )
})

test('carried assets keep the exact bytes and a sha256 of them', () => {
  const root = fixture({ 'CLAUDE.md': 'line one\nline two\n' })
  const asset = readRuleAsset(join(root, 'CLAUDE.md'), 'claude')
  assert.equal(asset.text, 'line one\nline two\n')
  assert.equal(asset.name, 'CLAUDE.md')
  assert.equal(asset.bytes, Buffer.byteLength('line one\nline two\n', 'utf8'))
  assert.match(asset.sha256, /^[0-9a-f]{64}$/u)
  // The same content yields the same hash; a change yields a different one.
  assert.equal(readRuleAsset(join(root, 'CLAUDE.md'), 'claude').sha256, asset.sha256)
  writeFileSync(join(root, 'other.md'), 'different\n', 'utf8')
  assert.notEqual(readRuleAsset(join(root, 'other.md'), 'claude').sha256, asset.sha256)
})

test('an oversized rule file fails loudly instead of being truncated', () => {
  const root = fixture({ 'big.md': 'x'.repeat(DEFAULT_MAX_RULE_BYTES + 1) })
  assert.throws(
    () => readRuleAsset(join(root, 'big.md'), 'claude'),
    (error) => error instanceof CompatAdapterError && /above the .* cap/u.test(error.message),
  )
})

test('rendered context states provenance, hashes, and that text is not enforced', () => {
  const root = fixture({ 'CLAUDE.md': '# Rules\n\nBe careful.\n' })
  const asset = readRuleAsset(join(root, 'CLAUDE.md'), 'claude')
  const text = renderRulesContext({ vendor: 'claude', formats: [...claude.RULES.formats], assets: [asset] })
  assert.match(text, /^## Carried claude rules/mu)
  assert.match(text, /carried verbatim from disk/u)
  assert.match(text, /not enforced configuration/u)
  assert.match(text, new RegExp(asset.sha256, 'u'))
  assert.match(text, /### CLAUDE\.md/u)
  assert.match(text, /Be careful\./u)
})

test('Codex rules context states the Starlark policy is documentation only', () => {
  const root = fixture({ 'rules.rules': 'prefix_rule(pattern = ["git", "push"], decision = "forbidden")\n' })
  const asset = readRuleAsset(join(root, 'rules.rules'), 'codex')
  const text = renderRulesContext({ vendor: 'codex', formats: [...codex.RULES.formats], assets: [asset] })
  assert.match(text, /Starlark command policy|command-execution policy|command policy/iu)
  assert.match(text, /NOT enforced/iu)
  assert.match(text, /never as a security boundary/iu)
})

test('a rules capability is CARRY with the injection seam and the vendor note', () => {
  const root = fixture({ 'CLAUDE.md': '# rules\n' })
  const asset = readRuleAsset(join(root, 'CLAUDE.md'), 'claude')
  const result = rulesCapability('claude', claude.RULES, [asset])
  assert.equal(result.capability, CAPABILITY.CARRY)
  assert.deepEqual([...result.seams], ['agent/created'])
  assert.equal(result.vendor, 'claude')
  assert.equal(result.note, claude.RULES.note)
  assert.equal(Object.isFrozen(result), true)
})

test('the injection source kind is adapter-specific so it is distinguishable in the log', () => {
  const source = rulesSource('codex', 2)
  assert.equal(source.kind, RULES_SOURCE_KIND)
  assert.equal(source.vendor, 'codex')
  assert.equal(source.files, 2)
  assert.notEqual(RULES_SOURCE_KIND, 'agent-instructions')
  assert.notEqual(RULES_SOURCE_KIND, 'user')
})

test('baseDir must be absolute when supplied', () => {
  assert.equal(resolveBaseDir('/tmp/x'), '/tmp/x')
  assert.throws(
    () => resolveBaseDir('relative/dir'),
    (error) => error instanceof CompatAdapterError && /must be an absolute path/u.test(error.message),
  )
})
