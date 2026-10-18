/**
 * End-to-end smoke: the adapter's declared hook really fires inside DSH.
 *
 * Everything else in this suite proves the adapter's bookkeeping. This file
 * proves the thing a user actually cares about: a hook declared through
 * `ctx.compatAdapter.registerHook(...)` executes through the SHIPPED official
 * bridge and its decision reaches the real DSH tool seam.
 *
 * The path under test is the whole declared→routed→translated chain:
 *   registerHook({vendor:'claude', event:'PreToolUse', handler})
 *     → adapter writes a bridge config and mounts @deepseek-ai/dsh-hooks-claude-code
 *     → bridge registers on tools/pre-execute
 *     → test fires ctx.waterfall('tools/pre-execute', exec)
 *     → bridge runs the command hook
 *     → decision comes back as PreToolDecision
 *
 * @module dsh-compat-adapter/test/smoke-bridge.test
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { permissionDecisionOutput } from '../src/vendors/shared.js'
import { createAdapterFixture } from './helpers/harness.js'
import { waitForJson } from './helpers/wait.js'

/**
 * Write an executable hook script and return its path.
 *
 * @param {string} body - shell script body.
 * @returns {string} absolute script path (chmod 0o755).
 */
function hookScript(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compat-hook-'))
  const file = join(dir, 'hook.sh')
  writeFileSync(file, `#!/usr/bin/env bash\nset -u\n${body}\n`, 'utf8')
  chmodSync(file, 0o755)
  return file
}

/**
 * Fire one `tools/pre-execute` waterfall and return the decision.
 *
 * @param {object} ctx - Harness context.
 * @param {object} exec - tool execution input.
 * @returns {Promise<object>} the PreToolDecision.
 */
async function firePreToolUse(ctx, exec) {
  return ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
}

test('smoke: a Claude PreToolUse hook blocks a tool through the real official bridge', async (t) => {
  // The blocking contract: stdout hookSpecificOutput.permissionDecision deny,
  // exit 0. Exit code 2 is deliberately NOT used (see README).
  const command = hookScript(`cat >/dev/null\nprintf '%s' '${permissionDecisionOutput({
    event: 'PreToolUse',
    decision: 'deny',
    reason: 'no writes in this preset',
  })}'\nexit 0`)

  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)

  const registration = await adapter.registerHook({
    vendor: 'claude',
    event: 'PreToolUse',
    matcher: 'Write',
    handler: command,
  })
  assert.equal(registration.capability, 'ADAPTED')

  const decision = await firePreToolUse(adapter.ctx, {
    callId: 'call-1',
    name: 'Write',
    arguments: { file_path: '/tmp/x', content: 'y' },
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'deny', `expected deny, got ${JSON.stringify(decision)}`)
  assert.match(decision.reason ?? '', /no writes in this preset/u)

  // A non-matching tool is untouched: the declared matcher is real, not decorative.
  const allowed = await firePreToolUse(adapter.ctx, {
    callId: 'call-2',
    name: 'Read',
    arguments: { file_path: '/tmp/x' },
    signal: new AbortController().signal,
  })
  assert.equal(allowed.kind, 'allow')
})

test('smoke: a Claude PreToolUse hook can ask, and the ask carries its reason', async (t) => {
  const command = hookScript(`cat >/dev/null\nprintf '%s' '${permissionDecisionOutput({
    event: 'PreToolUse',
    decision: 'ask',
    reason: 'confirm the shell command',
  })}'\nexit 0`)

  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', handler: command })

  const decision = await firePreToolUse(adapter.ctx, {
    callId: 'call-3',
    name: 'Bash',
    arguments: { command: 'rm -rf /tmp/x' },
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason ?? '', /confirm the shell command/u)
})

test('smoke: a Codex PreToolUse hook blocks through the codex bridge', async (t) => {
  const command = hookScript(`cat >/dev/null\nprintf '%s' '${permissionDecisionOutput({
    event: 'PreToolUse',
    decision: 'deny',
    reason: 'codex preset forbids this command',
  })}'\nexit 0`)

  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'codex', event: 'PreToolUse', handler: command })
  assert.equal(registration.capability, 'ADAPTED')

  const decision = await firePreToolUse(adapter.ctx, {
    callId: 'call-4',
    name: 'Bash',
    arguments: { command: 'git push' },
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'deny', `expected deny, got ${JSON.stringify(decision)}`)
  assert.match(decision.reason ?? '', /codex preset forbids/u)
})

test('smoke: an allow-decision hook does not block, and a plain passing hook allows', async (t) => {
  const command = hookScript('cat >/dev/null\nexit 0')
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', handler: command })
  const decision = await firePreToolUse(adapter.ctx, {
    callId: 'call-5',
    name: 'Write',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'allow')
})

test('smoke: two hooks on the same event both run; deny wins over a later allow', async (t) => {
  const deny = hookScript(`cat >/dev/null\nprintf '%s' '${permissionDecisionOutput({
    event: 'PreToolUse',
    decision: 'deny',
    reason: 'first hook says no',
  })}'\nexit 0`)
  const allow = hookScript('cat >/dev/null\nexit 0')

  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ id: 'deny-hook', vendor: 'claude', event: 'PreToolUse', handler: deny })
  await adapter.registerHook({ id: 'allow-hook', vendor: 'claude', event: 'PreToolUse', handler: allow })

  const decision = await firePreToolUse(adapter.ctx, {
    callId: 'call-6',
    name: 'Bash',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason ?? '', /first hook says no/u)
})

test('smoke: a blocking hook that uses exit 2 is NOT relied on by this adapter', async (t) => {
  // Documents the contract difference without depending on it: an exit-2 hook
  // is a user-written declaration; the adapter itself never generates one.
  // This test pins the adapter's own generated output, not the bridge's
  // exit-2 behavior (which the task brief reports as unreliable).
  const generated = permissionDecisionOutput({ event: 'PreToolUse', decision: 'deny', reason: 'r' })
  const parsed = JSON.parse(generated)
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(parsed.decision, undefined, 'generated blocking must not use the legacy top-level decision field')

  // And the documented bridge behavior for a clean exit 0 + deny really denies.
  const command = hookScript(`cat >/dev/null\nprintf '%s' '${generated}'\nexit 0`)
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', handler: command })
  const decision = await firePreToolUse(adapter.ctx, {
    callId: 'call-7',
    name: 'Write',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'deny')
})

test('smoke: Codex `ask` is NOT honored — the documented degradation is real', async (t) => {
  // The Codex bridge honors deny only; Codex `permissionDecision: "ask"` has no
  // approval path, so the tool proceeds. The adapter's capability table says so
  // on every Codex PreToolUse registration; this test pins the real behavior so
  // the documentation cannot drift into claiming an ask that never happens.
  const command = hookScript(`cat >/dev/null\nprintf '%s' '${permissionDecisionOutput({
    event: 'PreToolUse',
    decision: 'ask',
    reason: 'please confirm',
  })}'\nexit 0`)

  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'codex', event: 'PreToolUse', handler: command })
  assert.ok(
    registration.degradations.some((line) => /ask/iu.test(line)),
    'the Codex PreToolUse registration must warn that ask is unsupported',
  )

  const decision = await firePreToolUse(adapter.ctx, {
    callId: 'codex-ask-1',
    name: 'Bash',
    arguments: { command: 'ls' },
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'allow', `Codex ask must degrade to allow, got ${JSON.stringify(decision)}`)
})

test('smoke: Claude `allow` does not pre-approve; DSH still runs its own pipeline', async (t) => {
  // Claude Code's `allow` means "skip the permission prompt", not "force allow".
  // The bridge does not translate it into a PreToolDecision, so the surrounding
  // DSH pipeline decides — the adapter must not claim it pre-approves.
  const command = hookScript(`cat >/dev/null\nprintf '%s' '${permissionDecisionOutput({
    event: 'PreToolUse',
    decision: 'allow',
  })}'\nexit 0`)

  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', handler: command })
  assert.ok(registration.degradations.some((line) => /allow does not pre-approve/iu.test(line)))

  const decision = await firePreToolUse(adapter.ctx, {
    callId: 'claude-allow-1',
    name: 'Bash',
    arguments: { command: 'ls' },
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'allow')
})

test('smoke: a Claude ConfigChange hook observes a settings update', async (t) => {
  const { chmodSync, mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-config-change-'))
  const trace = join(dir, 'settings.json')
  const file = join(dir, 'hook.sh')
  writeFileSync(file, `#!/usr/bin/env bash\ncat > ${trace}\nprintf '%s' '{}'\nexit 0\n`, 'utf8')
  chmodSync(file, 0o755)

  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'claude', event: 'ConfigChange', handler: file })
  assert.equal(registration.capability, 'ADAPTED')
  assert.equal(registration.seams[0], 'settings/document-updated')

  await adapter.ctx.parallel('settings/document-updated', 'ui-settings-general', 7)
  const payload = await waitForJson(trace)
  assert.equal(payload.namespace, 'ui-settings-general')
  assert.equal(payload.revision, 7)
  assert.equal(payload.filePath, null, 'DSH reports namespaces, not files; filePath must stay null')
})
