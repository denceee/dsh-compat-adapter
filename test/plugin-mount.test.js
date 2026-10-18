/**
 * Mounting the real plugin entry (`index.js`) in a real Harness.
 *
 * The service tests construct `CompatAdapter` directly, which skips the plugin
 * wrapper: `apply`, the config schema, `ctx.provide`, and the disposer. A preset
 * author only ever gets the wrapper, so the wrapper's own contract is tested
 * here — including that an ASYNC `apply` (the documented usage pattern) really
 * makes the service available once the plugin fiber settles.
 *
 * @module dsh-compat-adapter/test/plugin-mount
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as plugin from '../index.js'
import { createHarness } from './helpers/harness.js'

/**
 * A preset-class plugin that declares assets in an ASYNC apply, exactly as the
 * README shows.
 *
 * @param {object} results - mutable sink for the capability results.
 * @returns {object} a Cordis plugin object.
 */
function declaringPreset(results) {
  return {
    name: 'declaring-preset',
    inject: ['compatAdapter'],
    async apply(ctx) {
      results.hook = await ctx.compatAdapter.registerHook({
        vendor: 'claude',
        event: 'PreToolUse',
        matcher: 'Write',
        handler: 'echo mounted',
      })
      results.rules = await ctx.compatAdapter.registerRules({
        vendor: 'codex',
        source: 'NOTE.md',
        baseDir: results.baseDir,
      })
    },
  }
}

test('the plugin mounts, provides the service, and an async preset can register in setup', async (t) => {
  const harness = await createHarness()
  const baseDir = mkdtempSync(join(tmpdir(), 'dsh-compat-mount-'))
  writeFileSync(join(baseDir, 'NOTE.md'), '# codex rules\n\ncarried by the mount test\n', 'utf8')
  const results = { baseDir }

  const adapterFiber = await harness.ctx.plugin(plugin, { logRegistrations: false })
  t.after(async () => {
    await adapterFiber.dispose()
    await harness.dispose()
  })

  assert.notEqual(harness.ctx.get('compatAdapter'), undefined, 'apply must provide ctx.compatAdapter')

  const presetFiber = await harness.ctx.plugin(declaringPreset(results))
  t.after(() => presetFiber.dispose())

  assert.equal(results.hook.capability, 'ADAPTED')
  assert.deepEqual([...results.hook.seams], ['tools/pre-execute'])
  assert.equal(results.rules.capability, 'CARRY')

  const adapter = harness.ctx.get('compatAdapter')
  const status = adapter.status()
  assert.equal(status.counts.executableHooks, 1)
  assert.equal(status.counts.carriedFiles, 1)
})

test('unloading the plugin disposer removes the service and every listener', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.dispose())
  const fiber = await harness.ctx.plugin(plugin, { logRegistrations: false })
  assert.notEqual(harness.ctx.get('compatAdapter'), undefined)
  const adapter = harness.ctx.get('compatAdapter')
  await fiber.dispose()
  assert.equal(harness.ctx.get('compatAdapter'), undefined, 'the service must disappear with its fiber')
  assert.equal(adapter.disposed, true)
  assert.equal(adapter.bridgeHost.mounted.size, 0)
})

test('failClosed=false still refuses to mount a hook without a shell, but keeps rules working', async (t) => {
  // failClosed controls whether a missing surface is an error or a graded
  // UNSUPPORTED result; either way an unsupported hook is never mounted.
  const harness = await createHarness({ withShell: false })
  const fiber = await harness.ctx.plugin(plugin, { logRegistrations: false, failClosed: false })
  t.after(async () => {
    await fiber.dispose()
    await harness.dispose()
  })
  const adapter = harness.ctx.get('compatAdapter')
  const hook = await adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', handler: 'echo x' })
  assert.equal(hook.capability, 'UNSUPPORTED')
  assert.equal(adapter.status().counts.executableHooks, 0)
  const baseDir = mkdtempSync(join(tmpdir(), 'dsh-compat-mount-'))
  writeFileSync(join(baseDir, 'R.md'), '# rules\n', 'utf8')
  const rules = await adapter.registerRules({ vendor: 'claude', source: 'R.md', baseDir })
  assert.equal(rules.capability, 'CARRY')
})
