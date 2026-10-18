/**
 * Documentation/code consistency.
 *
 * The READMEs publish a support matrix. A hand-written table drifts; this test
 * renders the matrix from the code and asserts each README contains exactly
 * that rendered block between its markers. If the tables change, `npm test`
 * fails until the READMEs are regenerated — so a document can never claim more
 * capability than the adapter has.
 *
 * Every translated README is checked (see `README_FILES`): a translation that
 * escaped this test could overclaim in a language the guard never reads.
 *
 * Regenerate with: `npm run matrix:write`
 *
 * @module dsh-compat-adapter/test/matrix-readme.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  MATRIX_END as END,
  MATRIX_START as START,
  README_FILES,
  buildMatrix,
  groupByCapability,
  renderMatrixMarkdown,
} from '../src/matrix.js'

const ROOT = new URL('..', import.meta.url).pathname

test('every README exists and has the generated matrix block', () => {
  for (const file of README_FILES) {
    const readme = readFileSync(join(ROOT, file), 'utf8')
    assert.ok(readme.includes(START), `${file} is missing ${START}`)
    assert.ok(readme.includes(END), `${file} is missing ${END}`)
  }
})

test('every README matrix block matches the code exactly', () => {
  const generated = renderMatrixMarkdown().trim()
  for (const file of README_FILES) {
    const readme = readFileSync(join(ROOT, file), 'utf8')
    const start = readme.indexOf(START)
    const end = readme.indexOf(END)
    assert.ok(start !== -1 && end > start, `${file} matrix markers are malformed`)
    const documented = readme.slice(start + START.length, end).trim()
    assert.equal(
      documented,
      generated,
      `${file} matrix is stale. Run \`npm run matrix:write\` (it rewrites every README block from src/matrix.js).`,
    )
  }
})

test('every declared event is executable, and every executable event states its losses', () => {
  for (const vendor of buildMatrix()) {
    assert.equal(vendor.hooks.length, vendor.supported + vendor.unsupported)
    assert.ok(vendor.supported > 0, `${vendor.vendor} has no executable event`)
    // Full adaptation is only honest when the losses travel with it: an ADAPTED
    // row without degradations would be an unqualified portability claim.
    for (const event of vendor.hooks) {
      if (event.capability !== 'ADAPTED') continue
      assert.ok(event.degradations.length > 0, `${vendor.vendor} ${event.event} claims ADAPTED with no degradations`)
      assert.ok(event.seams.length > 0, `${vendor.vendor} ${event.event} claims ADAPTED with no DSH seam`)
    }
    assert.equal(vendor.rules.capability, 'CARRY')
  }
})

test('the aggregate grading never claims DIRECT anywhere', () => {
  const grouped = groupByCapability()
  assert.equal(grouped.DIRECT.length, 0, 'no event may claim DIRECT: every bridge is a declared approximation')
})

test('full coverage does not become an unqualified portability claim', () => {
  // Every vendor now maps every declared event, which is only acceptable because
  // each row lists its losses and the aggregate never claims DIRECT. This test is
  // the guard that stops "support everything" from silently meaning "pretend
  // everything is byte-faithful".
  const grouped = groupByCapability()
  assert.equal(grouped.DIRECT.length, 0, 'no event may claim DIRECT')
  for (const vendor of buildMatrix()) {
    assert.equal(vendor.unsupported, 0, `${vendor.vendor} unexpectedly still refuses events`)
    const approximate = vendor.hooks.filter((event) => event.capability === 'ADAPTED').length
    assert.equal(approximate, vendor.hooks.length, `${vendor.vendor} has non-ADAPTED executable rows`)
  }
})

test('the five vendors are exactly the declared ones', () => {
  assert.deepEqual(buildMatrix().map((vendor) => vendor.vendor), ['claude', 'codex', 'workbuddy', 'opencode', 'copilot'])
})
