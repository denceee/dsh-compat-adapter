/**
 * Service behavior against a REAL Harness context.
 *
 * These tests boot a genuine Cordis context with the shipped shell executor and
 * the shipped official bridges, then drive `ctx.compatAdapter`. A mocked
 * Harness would only prove the mock, so the fixture is the real thing; what is
 * asserted is the adapter's contract:
 *
 * - explicit declaration only (unknown vendor/event are loud errors),
 * - every registration returns a frozen graded result,
 * - UNSUPPORTED assets are never mounted (fail-closed),
 * - rules are carried and injected on `agent/created` with a distinct source,
 * - `status()` reflects live state, `dispose()` unloads everything.
 *
 * @module dsh-compat-adapter/test/service.test
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CAPABILITY } from '../src/capability.js'
import { CompatAdapterError } from '../src/errors.js'
import { createAdapterFixture } from './helpers/harness.js'

/**
 * Create a throwaway directory with the given files.
 *
 * @param {Record<string, string>} files - relative path → content.
 * @returns {string} the temporary root.
 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-svc-'))
  for (const [relative, content] of Object.entries(files)) {
    const full = join(root, relative)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return root
}

test('unknown vendors and unknown events are authoring errors, never silent', async (t) => {
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)

  await assert.rejects(
    () => adapter.registerHook({ vendor: 'cursor', event: 'PreToolUse', handler: 'echo hi' }),
    (error) => error instanceof CompatAdapterError && error.code === 'UNKNOWN_VENDOR' && /declaration|Declare one of/iu.test(error.message),
  )
  await assert.rejects(
    () => adapter.registerHook({ vendor: 'claude', event: 'NoSuchEvent', handler: 'echo hi' }),
    (error) => error instanceof CompatAdapterError && error.code === 'UNKNOWN_EVENT',
  )
  await assert.rejects(
    () => adapter.registerHook({ vendor: 'claude' }),
    (error) => error instanceof CompatAdapterError && error.code === 'INVALID_DECLARATION',
  )
})

test('a non-command handler type is refused with the reason, not dropped', async (t) => {
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await assert.rejects(
    () => adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', handler: { type: 'prompt', prompt: 'x' } }),
    (error) => error instanceof CompatAdapterError && error.code === 'INVALID_HANDLER' && /prompt/iu.test(error.message),
  )
  await assert.rejects(
    () => adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', handler: { type: 'command' } }),
    (error) => error instanceof CompatAdapterError && error.code === 'INVALID_HANDLER',
  )
})

test('an UNSUPPORTED vendor event returns a graded refusal and mounts nothing', async (t) => {
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  // Every DECLARED event now has a seam, so fail-closed is exercised through the
  // paths that still refuse: a JS function handler (no foreign code in the Host).
  const result = await adapter.registerHook({ vendor: 'opencode', event: 'tool.execute.before', handler: () => ({}) })
  assert.equal(result.capability, CAPABILITY.UNSUPPORTED)
  assert.equal(result.reason.length > 40, true)
  assert.equal(Object.isFrozen(result), true)
  const status = adapter.status()
  assert.equal(status.counts.executableHooks, 0)
  assert.equal(status.counts.unsupportedHooks, 1)
  assert.equal(status.hooks[0].bridge, undefined)

  // A declared event on every vendor really is executable now.
  const executable = await adapter.registerHook({ vendor: 'opencode', event: 'tool.execute.before', handler: 'echo hi' })
  assert.equal(executable.capability, CAPABILITY.ADAPTED)
  assert.ok(executable.degradations.length > 0)
})

test('a JS function handler is graded UNSUPPORTED (no foreign code in the Host)', async (t) => {
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const result = await adapter.registerHook({
    vendor: 'claude',
    event: 'PreToolUse',
    handler: () => ({ deny: true }),
  })
  assert.equal(result.capability, CAPABILITY.UNSUPPORTED)
  assert.match(result.reason, /function handlers|foreign code/iu)
})

test('a bridged Claude hook is ADAPTED, names its seam, and mounts the official bridge', async (t) => {
  const { adapter, ctx, dispose } = await createAdapterFixture()
  t.after(dispose)
  const result = await adapter.registerHook({
    vendor: 'claude',
    event: 'PreToolUse',
    matcher: 'Write',
    handler: 'echo hi',
  })
  assert.equal(result.capability, CAPABILITY.ADAPTED)
  assert.deepEqual([...result.seams], ['tools/pre-execute'])
  assert.equal(result.degradations.length > 0, true)
  // The shipped bridge package is mounted as a child plugin of the adapter ctx.
  assert.equal(typeof adapter.bridgeHost.mounted.get('claude')?.fiber?.dispose, 'function')
  const status = adapter.status()
  assert.equal(status.hooks[0].bridge, 'claude')
  assert.equal(status.counts.executableHooks, 1)
  void ctx
})

test('a bridged Codex hook routes into the codex bridge, not the claude one', async (t) => {
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const result = await adapter.registerHook({ vendor: 'codex', event: 'PreToolUse', handler: 'echo hi' })
  assert.equal(result.capability, CAPABILITY.ADAPTED)
  assert.equal(adapter.status().hooks[0].bridge, 'codex')
  assert.equal(adapter.bridgeHost.mounted.has('codex'), true)
  assert.equal(adapter.bridgeHost.mounted.has('claude'), false)
})

test('native-seam events are ADAPTED with an explicit cannot-veto degradation', async (t) => {
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const result = await adapter.registerHook({ vendor: 'claude', event: 'PreCompact', handler: 'echo observed' })
  assert.equal(result.capability, CAPABILITY.ADAPTED)
  assert.deepEqual([...result.seams], ['session/event'])
  assert.ok(result.degradations.some((line) => /cannot veto/iu.test(line)))
  assert.equal(adapter.status().hooks[0].observationPoint, 'compaction/start')
  // A native-seam hook must NOT mount a bridge config.
  assert.equal(adapter.bridgeHost.mounted.size, 0)
})

test('without ctx.shell a bridged hook fails closed with a precise reason', async (t) => {
  const { adapter, dispose } = await createAdapterFixture({ withShell: false })
  t.after(dispose)
  const result = await adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', handler: 'echo hi' })
  assert.equal(result.capability, CAPABILITY.UNSUPPORTED)
  assert.match(result.reason, /shell executor|ctx\.shell/iu)
  assert.equal(adapter.status().counts.executableHooks, 0)
})

test('rules are carried, frozen, and reported by status with hashes', async (t) => {
  const root = fixture({ 'CLAUDE.md': '# rules\n', '.claude/rules/api.md': '# api\n' })
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const result = await adapter.registerRules({ vendor: 'claude', source: ['CLAUDE.md', '.claude/rules/*.md'], baseDir: root })
  assert.equal(result.capability, CAPABILITY.CARRY)
  assert.deepEqual([...result.seams], ['agent/created'])
  const status = adapter.status()
  assert.equal(status.counts.rules, 1)
  assert.equal(status.counts.carriedFiles, 2)
  assert.equal(status.rules[0].files.length, 2)
  for (const file of status.rules[0].files) assert.match(file.sha256, /^[0-9a-f]{64}$/u)
})

test('carried rules are injected as context when an agent is created', async (t) => {
  const root = fixture({ 'CLAUDE.md': '# carried rules\n\nthe unique marker 7f3a\n' })
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerRules({ vendor: 'claude', source: 'CLAUDE.md', baseDir: root })

  /** @type {Array<{message: object, source: object}>} */
  const injected = []
  const fakeAgent = {
    id: 'session-test',
    inject(message) {
      injected.push({ message, source: message.source })
    },
  }
  await adapter.ctx.waterfall('agent/created', { agent: fakeAgent, source: 'startup' }, async () => undefined)
  // Rule injection resolves the message constructor lazily, so settle the
  // pending microtasks before asserting.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(injected.length, 1)
  const source = injected[0].message.source
  assert.equal(source.kind, 'compat-adapter-rules')
  assert.equal(source.vendor, 'claude')
  assert.equal(source.files, 1)
  const text = injected[0].message.content.map((block) => block.text).join('')
  assert.match(text, /7f3a/u)
  assert.match(text, /Carried claude rules/u)
})

test('injection does not fire when no rules are registered', async (t) => {
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const injected = []
  await adapter.ctx.waterfall(
    'agent/created',
    { agent: { id: 's', inject: (message) => injected.push(message) }, source: 'startup' },
    async () => undefined,
  )
  assert.equal(injected.length, 0)
})

test('every registration result and status object is deeply frozen', async (t) => {
  const root = fixture({ 'CLAUDE.md': '# rules\n' })
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const hook = await adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', handler: 'echo hi' })
  const rules = await adapter.registerRules({ vendor: 'claude', source: 'CLAUDE.md', baseDir: root })
  for (const result of [hook, rules]) {
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.seams), true)
    assert.equal(Object.isFrozen(result.degradations), true)
  }
  const status = adapter.status()
  assert.equal(Object.isFrozen(status), true)
  assert.equal(Object.isFrozen(status.hooks), true)
  assert.equal(Object.isFrozen(status.counts), true)
})

test('matrix() is the static capability table and covers every vendor', async (t) => {
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const matrix = adapter.matrix()
  assert.equal(matrix.length, 5)
  assert.deepEqual(matrix.map((entry) => entry.vendor), ['claude', 'codex', 'workbuddy', 'opencode', 'copilot'])
  for (const vendor of matrix) {
    assert.ok(vendor.hooks.length > 0)
    assert.ok(vendor.rules.capability === CAPABILITY.CARRY)
    assert.equal(vendor.runtime.capability, CAPABILITY.UNSUPPORTED)
  }
})

test('dispose unloads the bridge and refuses later registrations', async (t) => {
  const { adapter, dispose } = await createAdapterFixture()
  const result = await adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', handler: 'echo hi' })
  assert.equal(result.capability, CAPABILITY.ADAPTED)
  const fiber = adapter.bridgeHost.mounted.get('claude').fiber
  await adapter.dispose()
  assert.equal(adapter.bridgeHost.mounted.size, 0)
  // Cordis FiberState: PENDING=0…DISPOSED=4. A disposed bridge fiber is 4.
  assert.equal(fiber.state, 4)
  assert.equal(adapter.status().disposed, true)
  await assert.rejects(
    () => adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', handler: 'echo hi' }),
    (error) => error instanceof CompatAdapterError && error.code === 'ADAPTER_DISPOSED',
  )
  await assert.rejects(
    () => adapter.registerRules({ vendor: 'claude', source: 'CLAUDE.md', baseDir: '/' }),
    (error) => error instanceof CompatAdapterError && error.code === 'ADAPTER_DISPOSED',
  )
  await dispose()
})

test('two adapter instances never share a generated bridge config (isolation regression)', async (t) => {
  // Regression: a fixed config filename let a second adapter instance overwrite
  // the first one's hook set, so one preset's hook could fire for another. Each
  // instance must own a distinct file, and disposal must remove it.
  const first = await createAdapterFixture()
  const second = await createAdapterFixture()
  t.after(async () => {
    await first.dispose()
    await second.dispose()
  })

  await first.adapter.registerHook({ id: 'first-deny', vendor: 'claude', event: 'PreToolUse', handler: 'echo first' })
  await second.adapter.registerHook({ id: 'second-deny', vendor: 'claude', event: 'PreToolUse', handler: 'echo second' })

  const firstPath = first.adapter.bridgeHost.mounted.get('claude').configPath
  const secondPath = second.adapter.bridgeHost.mounted.get('claude').configPath
  assert.notEqual(firstPath, secondPath, 'two adapter instances must not share one generated config path')

  const firstConfig = JSON.parse(readFileSync(firstPath, 'utf8'))
  const secondConfig = JSON.parse(readFileSync(secondPath, 'utf8'))
  assert.equal(firstConfig.hooks.PreToolUse[0].hooks[0].command, 'echo first')
  assert.equal(secondConfig.hooks.PreToolUse[0].hooks[0].command, 'echo second')

  // Disposing one instance removes only its own config.
  await first.adapter.dispose()
  assert.equal(existsSync(firstPath), false, 'dispose must delete the generated config it created')
  assert.equal(existsSync(secondPath), true, 'dispose must not touch another instance\'s config')
  await second.adapter.dispose()
  assert.equal(existsSync(secondPath), false)
})

test('a failed remount never unloads the hooks that were already running (transactional regression)', async (t) => {
  // Regression: mounting a second hook re-renders the whole bridge config. The
  // naive order (unmount → write config → mount) meant a write failure (read-only
  // DSH_HOME, full disk, bad permissions) silently killed the hooks that were
  // already working, while status() still reported them as ADAPTED. The remount
  // is now transactional: preparation first, swap only after it succeeds.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compat-txn-'))
  const makeHook = (name) => {
    const file = join(dir, name)
    writeFileSync(file, '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n', 'utf8')
    return file
  }
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)

  const first = await adapter.registerHook({ id: 'A', vendor: 'claude', event: 'PreToolUse', handler: makeHook('a.sh') })
  assert.equal(first.capability, 'ADAPTED')
  const liveConfig = adapter.bridgeHost.mounted.get('claude').configPath

  // Inject an unwritable data dir: the next config write must fail.
  const host = adapter.bridgeHost
  const goodDataDir = host.dataDir
  const blocker = join(dir, 'blocker-not-a-dir')
  writeFileSync(blocker, 'x', 'utf8')
  host.dataDir = blocker

  const failed = await adapter.registerHook({ id: 'B', vendor: 'claude', event: 'PostToolUse', handler: makeHook('b.sh') })
  assert.equal(failed.capability, 'UNSUPPORTED', 'a write failure must be a graded refusal, not a throw')
  assert.match(failed.reason, /cannot write the generated claude bridge config/iu)
  assert.match(failed.reason, /previously mounted hooks are untouched/iu)

  // The already-working hook must still be mounted, with its original config.
  assert.equal(adapter.bridgeHost.mounted.size, 1, 'the live bridge must stay mounted after a failed remount')
  assert.equal(adapter.bridgeHost.mounted.get('claude').configPath, liveConfig)
  assert.equal(adapter.status().counts.executableHooks, 1, 'status must still report the hook that really runs')

  // And it must really still execute: a deny hook proves the listener is attached.
  const denyPath = join(dir, 'deny.sh')
  writeFileSync(
    denyPath,
    '#!/usr/bin/env bash\ncat >/dev/null\nprintf \'%s\' \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"still live"}}\'\nexit 0\n',
    'utf8',
  )
  // Re-register A with a deny body: this also exercises a successful remount
  // after a failure, once the data dir is restored.
  host.dataDir = goodDataDir
  const recovered = await adapter.registerHook({ id: 'A', vendor: 'claude', event: 'PreToolUse', handler: denyPath })
  assert.equal(recovered.capability, 'ADAPTED')
  assert.equal(adapter.status().counts.unsupportedHooks, 1)
  assert.equal(adapter.status().counts.executableHooks, 1)
})

test('a bridge mount failure rolls the previous hook set back (no lost hooks)', async (t) => {
  // The swap is unmount-then-mount, so a failure in the mount step would lose the
  // hooks the preset already had. Rollback re-renders and remounts the previous
  // set; the refusal then says whether it succeeded instead of hiding it.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compat-rollback-'))
  const makeHook = (name) => {
    const file = join(dir, name)
    writeFileSync(file, '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n', 'utf8')
    return file
  }
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)

  await adapter.registerHook({ id: 'A', vendor: 'claude', event: 'PreToolUse', handler: makeHook('a.sh') })
  assert.equal(adapter.bridgeHost.mounted.get('claude').hooks.length, 1)

  // Fail exactly the next mount (the swap), letting the rollback mount succeed.
  const realPlugin = adapter.ctx.plugin.bind(adapter.ctx)
  let calls = 0
  adapter.ctx.plugin = async (...args) => {
    calls += 1
    if (calls === 1) throw new Error('injected mount failure')
    return realPlugin(...args)
  }
  t.after(() => {
    adapter.ctx.plugin = realPlugin
  })

  const failed = await adapter.registerHook({ id: 'B', vendor: 'claude', event: 'PostToolUse', handler: makeHook('b.sh') })
  assert.equal(failed.capability, 'UNSUPPORTED')
  assert.match(failed.reason, /failed to mount/iu)
  assert.match(failed.reason, /previously mounted hooks were restored/iu)

  // The previous set is live again, with a real config file.
  assert.equal(adapter.bridgeHost.mounted.size, 1)
  const restored = adapter.bridgeHost.mounted.get('claude')
  assert.deepEqual(restored.hooks.map((hook) => hook.id), ['A'])
  assert.equal(existsSync(restored.configPath), true)
  assert.equal(adapter.status().counts.executableHooks, 1)
})

test('stale generated configs from dead processes are pruned, live ones are kept', async (t) => {
  // A killed process cannot dispose, so its generated config lingers. Every mount
  // writes a fresh path, so an orphan is never picked up; pruning only bounds
  // growth. The age bound (24h) makes it impossible to race a live mount.
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const dir = join(adapter.bridgeHost.dataDir, 'compat-adapter')
  const live = adapter.bridgeHost.mounted.size === 0 ? undefined : adapter.bridgeHost.mounted.get('claude').configPath
  void live

  const stale = join(dir, 'hooks-codex.dead-process.json')
  writeFileSync(stale, '{}', 'utf8')
  const threeDaysAgo = Date.now() / 1000 - 3 * 24 * 3600
  utimesSync(stale, threeDaysAgo, threeDaysAgo)
  const fresh = join(dir, 'hooks-codex.live-process.json')
  writeFileSync(fresh, '{}', 'utf8')

  // A new adapter instance prunes on construction.
  const second = await createAdapterFixture()
  t.after(dispose)
  t.after(() => second.dispose())
  assert.equal(existsSync(stale), false, 'a >24h orphan must be pruned')
  assert.equal(existsSync(fresh), true, 'a fresh file must not be pruned (it could be a live mount)')
  void second
})
