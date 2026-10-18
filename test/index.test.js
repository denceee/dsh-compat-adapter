/**
 * Plugin entry and bundle metadata.
 *
 * The entry module is what the Loader loads, so its export shape, config schema
 * and patch file are part of the contract. A bundle that loads in a unit test
 * but has a malformed `dsh.bundle.patch` would only fail at install time in a
 * user's profile, which is the worst place to discover it.
 *
 * @module dsh-compat-adapter/test/index.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import * as plugin from '../index.js'
import { DSH_SURFACE } from '../src/surface.js'

const ROOT = new URL('..', import.meta.url).pathname

/** Parse a repository JSON file. */
function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), 'utf8'))
}

test('the entry module exports the Cordis plugin contract', () => {
  assert.equal(plugin.name, 'compat-adapter')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject), 'inject must be an array')
  assert.deepEqual([...plugin.inject], [], 'inject must stay empty so rules-only compositions still work')
  assert.equal(typeof plugin.Config, 'function')
})

test('the config schema validates defaults and rejects wrong types', () => {
  const defaults = plugin.Config({})
  assert.equal(defaults.logRegistrations, true)
  assert.equal(defaults.failClosed, true)
  assert.equal(defaults.targetDshVersion, DSH_SURFACE.dshVersion)
  assert.equal(defaults.maxRuleBytes, 512 * 1024)
  assert.throws(() => plugin.Config({ logRegistrations: 'yes' }), /expected boolean/iu)
})

test('package.json declares a DSH bundle patch that exists', () => {
  const manifest = readJson('package.json')
  assert.equal(manifest.name, 'dsh-compat-adapter')
  assert.equal(manifest.type, 'module')
  assert.ok(manifest.dsh?.bundle?.patch, 'dsh.bundle.patch is required for a bundle')
  const patchPath = join(ROOT, manifest.dsh.bundle.patch)
  assert.doesNotThrow(() => readFileSync(patchPath, 'utf8'))
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./matrix'], './src/matrix.js')
})

test('the bundle patch inserts exactly one host row with a bare package specifier', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  // Strip comments first: the file documents the baseUrl/node_modules pitfall in
  // prose, and that prose must not be mistaken for patch content.
  const content = patch
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  // A baseUrl-relative or node_modules-prefixed name is the documented pitfall:
  // in a bundle patch baseUrl is the PROFILE ROOT, not the patch directory.
  assert.match(content, /- insert:/u)
  assert.match(content, /id: compat-adapter/u)
  assert.match(content, /name: 'dsh-compat-adapter'/u)
  assert.doesNotMatch(content, /name: ['"]?\.\//u, 'the row name must not be a relative path')
  assert.doesNotMatch(content, /node_modules\//u, 'the row name must not embed node_modules')
  const rows = [...content.matchAll(/^\s*(-\s+)?id: /gmu)]
  assert.equal(rows.length, 1, 'exactly one row is inserted')
})

test('peerDependencies pin the verified DSH version exactly', () => {
  const manifest = readJson('package.json')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], DSH_SURFACE.dshVersion)
  for (const bridge of ['@deepseek-ai/dsh-hooks-claude-code', '@deepseek-ai/dsh-hooks-codex', '@deepseek-ai/dsh-hook-protocol']) {
    assert.equal(manifest.peerDependencies[bridge], DSH_SURFACE.dshVersion, `${bridge} must be pinned to the verified version`)
  }
  assert.ok(manifest.engines.node.length > 0)
})

test('locale metadata exists in both languages and names the plugin', () => {
  for (const locale of ['en', 'zh']) {
    const meta = readJson(`locale/${locale}.json`)
    assert.ok(meta.meta.title.length > 0)
    assert.ok(meta.meta.description.length > 20)
  }
})

test('the surface module pins the version every doc mentions', () => {
  assert.match(DSH_SURFACE.dshVersion, /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/u)
  assert.ok(DSH_SURFACE.events.length > 0)
  assert.ok(DSH_SURFACE.services.length > 0)
  assert.ok(Object.keys(DSH_SURFACE.packages).length > 0)
})
