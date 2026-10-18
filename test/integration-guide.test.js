/**
 * The integration guide must be executable, not aspirational.
 *
 * INTEGRATION.md tells another plugin's author exactly what to write. This test
 * takes those snippets as written and runs them against a real Harness context,
 * so the guide cannot drift away from the API it documents.
 *
 * @module dsh-compat-adapter/test/integration-guide
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAdapterFixture } from './helpers/harness.js'

const ROOT = new URL('..', import.meta.url).pathname

test('the integration guide exists and is linked from both READMEs', () => {
  const guide = readFileSync(join(ROOT, 'INTEGRATION.md'), 'utf8')
  assert.match(guide, /inject.*compatAdapter/u, 'the guide must show the required inject declaration')
  assert.match(guide, /registerHook/u)
  assert.match(guide, /registerRules/u)
  // Both READMEs must point at it, or a reader never finds it.
  for (const readme of ['README.md', 'README.en.md']) {
    assert.match(readFileSync(join(ROOT, readme), 'utf8'), /INTEGRATION\.md/u, `${readme} must link the integration guide`)
  }
})

test('the guide\'s copy-paste shape works: inject + registerHook + registerRules', async (t) => {
  // Exactly the shape INTEGRATION.md section 6 shows, with a command handler.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-guide-'))
  const script = join(dir, 'guard.sh')
  writeFileSync(script, '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n', 'utf8')
  const { chmodSync } = await import('node:fs')
  chmodSync(script, 0o755)

  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)

  // A consumer plugin that declares the documented `inject` and registers.
  const consumer = {
    name: 'guide-consumer',
    inject: ['compatAdapter'],
    results: [],
    async apply(ctx) {
      this.results.push(
        await ctx.compatAdapter.registerHook({ vendor: 'copilot', event: 'preToolUse', matcher: 'bash', handler: script }),
      )
      writeFileSync(join(dir, 'CLAUDE.md'), '# rules\n', 'utf8')
      this.results.push(
        await ctx.compatAdapter.registerRules({ vendor: 'claude', source: 'CLAUDE.md', baseDir: dir }),
      )
    },
  }
  // The fixture provides the service directly, so emulate the injected context.
  adapter.ctx.compatAdapter = adapter
  await consumer.apply(adapter.ctx)

  assert.equal(consumer.results[0].capability, 'ADAPTED')
  assert.equal(consumer.results[1].capability, 'CARRY')
  // The guide promises status() lets a consumer self-check.
  const status = adapter.ctx.compatAdapter.status()
  assert.equal(status.counts.executableHooks, 1)
  assert.equal(status.counts.carriedFiles, 1)
})

test('the guide\'s documented error codes are the real ones', async (t) => {
  const { CompatAdapterError } = await import('../src/errors.js')
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)

  // UNKNOWN_VENDOR
  await assert.rejects(
    () => adapter.registerHook({ vendor: 'nope', event: 'x', handler: 'echo' }),
    (error) => error instanceof CompatAdapterError && error.code === 'UNKNOWN_VENDOR',
  )
  // UNKNOWN_EVENT — the guide promises the message lists known events.
  await assert.rejects(
    () => adapter.registerHook({ vendor: 'copilot', event: 'PreToolUse', handler: 'echo' }),
    (error) => error instanceof CompatAdapterError && error.code === 'UNKNOWN_EVENT' && /preToolUse/u.test(error.message),
  )
  // INVALID_HANDLER for non-command handler families.
  await assert.rejects(
    () => adapter.registerHook({ vendor: 'copilot', event: 'preToolUse', handler: { type: 'http', url: 'x' } }),
    (error) => error instanceof CompatAdapterError && error.code === 'INVALID_HANDLER',
  )
  // ADAPTER_DISPOSED after dispose.
  await adapter.dispose()
  await assert.rejects(
    () => adapter.registerHook({ vendor: 'copilot', event: 'preToolUse', handler: 'echo' }),
    (error) => error instanceof CompatAdapterError && error.code === 'ADAPTER_DISPOSED',
  )
})

test('the guide\'s vendor-name casing table matches the real tables', async () => {
  const { vendorModule } = await import('../src/vendors/index.js')
  // Copilot is lowerCamelCase; the others the guide lists as PascalCase.
  assert.ok(Object.keys(vendorModule('copilot').HOOKS).includes('preToolUse'))
  assert.ok(!Object.keys(vendorModule('copilot').HOOKS).includes('PreToolUse'))
  for (const vendor of ['claude', 'codex', 'workbuddy']) {
    assert.ok(Object.keys(vendorModule(vendor).HOOKS).includes('PreToolUse'), `${vendor} uses PascalCase`)
  }
  assert.ok(Object.keys(vendorModule('opencode').HOOKS).includes('tool.execute.before'))
})

test('the package exposes types so consumers get completion', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.types, './index.d.ts', 'package.json must declare types')
  assert.equal(manifest.exports['.'].types, './index.d.ts', 'the root export must expose types')
  assert.ok(manifest.files.includes('index.d.ts'), 'the declarations must ship in the package')
  assert.ok(manifest.files.includes('INTEGRATION.md'), 'the guide must ship in the package')
  const types = readFileSync(join(ROOT, 'index.d.ts'), 'utf8')
  for (const symbol of ['CompatAdapterService', 'HookDeclaration', 'RulesDeclaration', 'CapabilityResult']) {
    assert.ok(types.includes(symbol), `index.d.ts must declare ${symbol}`)
  }
  // The service must be merged onto the Cordis Context so `ctx.compatAdapter` types.
  assert.match(types, /declare module '@deepseek-ai\/cordis'/u)
})
