/**
 * Prose/code numeric consistency.
 *
 * `matrix-readme.test.js` only pins the generated matrix block between the
 * MATRIX markers. Everything a human writes *around* that block — badge alts,
 * the vendor summary table, the mermaid route counts, the "N events are
 * executable" sentence, the declared test count, `package.json`'s description —
 * is not covered by it, and that prose is where a capability claim can quietly
 * grow past the code.
 *
 * Concretely: this suite was added after `package.json` shipped a description
 * reading "112 events (107 real/precise)" while the vendor tables in the same
 * repository labelled **10** events `Approximate` — i.e. 102 precise. The
 * matrix block was accurate the whole time; nothing tested the sentence next to
 * it. This file derives every published number from the code and fails on the
 * first one that drifts.
 *
 * Regenerate the numbers by editing the prose to match the code (there is
 * deliberately no auto-writer for prose: a human writing a claim should have to
 * read it back).
 *
 * @module dsh-compat-adapter/test/doc-counts
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { README_FILES, buildMatrix } from '../src/matrix.js'
import { NATIVE_TRANSLATIONS } from '../src/translate.js'

const ROOT = new URL('..', import.meta.url).pathname

/** Read a repository file as UTF-8. */
function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/**
 * Derive every number this plugin publishes, from code rather than prose.
 *
 * @returns {object} aggregate and per-vendor counts.
 */
function countsFromCode() {
  const vendors = buildMatrix()
  let events = 0
  let approximate = 0
  const route = { 'official-bridge': 0, 'native-translate': 0, 'native-seam': 0, 'builtin-bridge': 0 }
  const perVendor = {}
  for (const vendor of vendors) {
    let vendorApproximate = 0
    const vendorRoute = { 'official-bridge': 0, 'native-translate': 0, 'native-seam': 0, 'builtin-bridge': 0 }
    for (const event of vendor.hooks) {
      const degrade = (event.degradations ?? []).join(' ').toLowerCase()
      if (degrade.includes('approximate')) {
        approximate += 1
        vendorApproximate += 1
      }
      if (route[event.route] !== undefined) route[event.route] += 1
      if (vendorRoute[event.route] !== undefined) vendorRoute[event.route] += 1
    }
    const total = vendor.hooks.length
    events += total
    perVendor[vendor.vendor] = { events: total, approximate: vendorApproximate, precise: total - vendorApproximate, route: vendorRoute }
  }
  return { events, approximate, precise: events - approximate, route, perVendor, points: Object.keys(NATIVE_TRANSLATIONS).length }
}

/**
 * Count top-level `test(...)` registrations across the suite.
 *
 * This mirrors what `node --test` reports in its `# tests` line (verified
 * per-file for every suite here), so the published count can be checked without
 * spawning a nested test run.
 *
 * @returns {number} the declared number of test cases.
 */
function countTestCases() {
  const dir = join(ROOT, 'test')
  let total = 0
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.test.js')) continue
    const source = readFileSync(join(dir, entry), 'utf8')
    for (const line of source.split('\n')) {
      if (/^\s*test\(/.test(line)) total += 1
    }
  }
  return total
}

/** Every README this repository publishes. */
const READMES = README_FILES

test('the published event total and precise/approximate split come from the code', () => {
  const c = countsFromCode()
  assert.equal(c.events, 112, 'the published event total drifted from the code')
  assert.equal(c.precise + c.approximate, c.events, 'precise + approximate must equal the total')
  // The split is the claim most likely to overstate capability, so it is asserted
  // by name rather than inferred: a future edit that relabels an event must move
  // these numbers in the prose too.
  assert.equal(c.approximate, 10, 'the approximated-event count drifted from the code')
  assert.equal(c.precise, 102, 'the precise-event count drifted from the code')
})

test('every published README states the real totals, not an older revision', () => {
  const c = countsFromCode()
  for (const file of READMES) {
    const body = read(file)
    assert.ok(
      body.includes(`hook%20events-${c.events}`) || body.includes(`hook%20events-${c.events}?`),
      `${file} badge does not advertise the real event total (${c.events})`,
    )
    assert.equal(
      body.includes(`All ${c.events} events`) || body.includes(`全部 ${c.events} 个事件`),
      true,
      `${file} does not state the real event total (${c.events}) in its grading table`,
    )
    // A document that mentions the total but never its split would still be able
    // to imply every row is faithful, so both halves must appear.
    assert.ok(body.includes(String(c.precise)), `${file} omits the precise-event count (${c.precise})`)
    assert.ok(body.includes(String(c.approximate)), `${file} omits the approximated-event count (${c.approximate})`)
    assert.ok(
      body.includes(`All ${c.precise}`) || body.includes(`**${c.precise} 个为真实`) || body.includes(`**${c.precise} are real`),
      `${file} does not state which events are precise (${c.precise})`,
    )
  }
})

test('the vendor summary table in every README matches the vendor modules', () => {
  const c = countsFromCode()
  for (const file of READMES) {
    const body = read(file)
    for (const [vendor, stats] of Object.entries(c.perVendor)) {
      const row = body.split('\n').find((line) => line.startsWith(`| \`${vendor}\` |`))
      assert.ok(row, `${file} has no summary row for vendor ${vendor}`)
      for (const value of [
        stats.events,
        stats.route['official-bridge'],
        stats.route['native-translate'],
        stats.route['native-seam'],
        stats.route['builtin-bridge'],
        stats.approximate,
      ]) {
        assert.ok(
          new RegExp(`(^|\\|)\\s*${value}\\s*\\|`).test(row),
          `${file} row for ${vendor} does not contain ${value}: ${row}`,
        )
      }
    }
  }
})

test('the published route counts in the workflow diagram match the code', () => {
  const c = countsFromCode()
  for (const file of READMES) {
    const body = read(file)
    for (const [name, value] of Object.entries(c.route)) {
      assert.ok(
        body.includes(`${name} · ${value}`),
        `${file} diagram does not state the real ${name} count (${value})`,
      )
    }
  }
})

test('the published native translation point count matches translate.js', () => {
  const c = countsFromCode()
  assert.ok(c.points > 0, 'no native translation points found')
  for (const file of READMES) {
    const body = read(file)
    assert.ok(
      body.includes(String(c.points)),
      `${file} does not state the real native translation point count (${c.points})`,
    )
  }
})

test('the published test count matches the suite on disk', () => {
  const declared = countTestCases()
  for (const file of READMES) {
    const body = read(file)
    assert.ok(
      body.includes(`tests-${declared}%20passing`),
      `${file} badge does not advertise the real test count (${declared})`,
    )
    assert.ok(
      body.includes(`${declared} cases`) || body.includes(`${declared} 个用例`),
      `${file} does not state the real test count (${declared})`,
    )
  }
})

test('every test file is documented in every README, and no documented file is missing', () => {
  const dir = join(ROOT, 'test')
  const onDisk = readdirSync(dir).filter((entry) => entry.endsWith('.test.js')).sort()
  for (const file of READMES) {
    const body = read(file)
    for (const entry of onDisk) {
      assert.ok(body.includes(`test/${entry}`), `${file} does not document test/${entry}`)
    }
    // The reverse direction matters too: a documented suite that no longer exists
    // would let the layout claim coverage the repository does not have.
    for (const match of body.matchAll(/test\/([a-z0-9-]+\.test\.js)/g)) {
      const named = match[1]
      if (named.startsWith('helpers')) continue
      assert.ok(onDisk.includes(named), `${file} documents test/${named}, which does not exist`)
    }
  }
})

test('INTEGRATION.md states the real totals and the four routes', () => {
  const c = countsFromCode()
  const body = read('INTEGRATION.md')
  // The consumer guide repeats the capability summary, so it is guarded the same
  // way the READMEs are: a guide that understates the loss is worse than a README
  // that does, because it is the document integrators actually follow.
  assert.ok(body.includes(String(c.events)), `INTEGRATION.md omits the event total (${c.events})`)
  assert.ok(body.includes(String(c.precise)), `INTEGRATION.md omits the precise count (${c.precise})`)
  assert.ok(body.includes(String(c.approximate)), `INTEGRATION.md omits the approximated count (${c.approximate})`)
  for (const name of Object.keys(c.route)) {
    assert.ok(body.includes(`\`${name}\``), `INTEGRATION.md does not document the ${name} route`)
  }
  for (const stale of ['85', '87', '107']) {
    assert.equal(body.includes(`${stale} 个事件`), false, `INTEGRATION.md still advertises ${stale} events`)
  }
})

test('package.json advertises the derived numbers, never a stale split', () => {
  const c = countsFromCode()
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.description, 'package.json has no description')
  assert.ok(pkg.description.includes(String(c.events)), `package.json description omits the event total (${c.events})`)
  assert.ok(pkg.description.includes(String(c.precise)), `package.json description omits the precise count (${c.precise})`)
  assert.ok(pkg.description.includes(String(c.approximate)), `package.json description omits the approximated count (${c.approximate})`)
  // 107 was the value that drifted; keep it out by name so a revert is loud.
  assert.ok(!pkg.description.includes('107'), 'package.json still advertises the retracted 107-precise figure')
})

test('no README advertises a retracted capability figure', () => {
  // These numbers were published in earlier revisions and no longer describe the
  // code. If a future revision makes one of them true again, update this list
  // deliberately rather than deleting the assertion.
  const retracted = ['85', '87']
  for (const file of READMES) {
    const body = read(file)
    for (const stale of retracted) {
      // Restrict to the shapes that actually carried the old claim, so unrelated
      // numbers (peer versions, ports, line numbers) never trip this.
      for (const pattern of [`events-${stale}`, `tests-${stale}%20passing`, `All ${stale} events`, `全部 ${stale} 个事件`, `${stale} 个用例`, `${stale} cases`]) {
        assert.equal(body.includes(pattern), false, `${file} still advertises the retracted figure "${pattern}"`)
      }
    }
  }
})
