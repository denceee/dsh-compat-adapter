/**
 * Copilot end-to-end smoke.
 *
 * Copilot is the one vendor with NO shipped DSH bridge, so its path is the
 * adapter's own translation layer. These tests prove the translation really
 * reaches DSH: a declared `preToolUse` hook must produce `{kind:'deny'}` at the
 * live `tools/pre-execute` seam, not merely a registered listener.
 *
 * @module dsh-compat-adapter/test/smoke-copilot
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAdapterFixture } from './helpers/harness.js'

/**
 * Write an executable hook emitting one stdout payload.
 *
 * @param {string} stdout - exact JSON to print.
 * @returns {string} script path.
 */
function hookScript(stdout) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-copilot-'))
  const file = join(dir, 'hook.sh')
  writeFileSync(file, `#!/usr/bin/env bash\nset -u\ncat >/dev/null\nprintf '%s' '${stdout}'\nexit 0\n`, 'utf8')
  chmodSync(file, 0o755)
  return file
}

/**
 * Fire the live pre-tool seam.
 *
 * @param {object} ctx - Harness context.
 * @param {object} exec - execution input.
 * @returns {Promise<object>} the decision.
 */
async function firePreTool(ctx, exec) {
  return ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
}

test('copilot: a preToolUse deny really blocks at the DSH tool seam', async (t) => {
  const command = hookScript(
    JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: 'copilot says no' }),
  )
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)

  const registration = await adapter.registerHook({ vendor: 'copilot', event: 'preToolUse', handler: command })
  assert.equal(registration.capability, 'ADAPTED')
  assert.equal(registration.seams[0], 'tools/pre-execute')

  const decision = await firePreTool(adapter.ctx, {
    callId: 'c1',
    name: 'bash',
    arguments: { command: 'rm -rf /tmp/x' },
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'deny', `expected deny, got ${JSON.stringify(decision)}`)
  assert.equal(decision.reason, 'copilot says no')
})

test('copilot: an allow decision falls through to the DSH pipeline', async (t) => {
  // Copilot `allow` means "do not prompt", not "force allow": the adapter must
  // not short-circuit DSH's own approval pipeline with it.
  const command = hookScript(JSON.stringify({ permissionDecision: 'allow' }))
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'copilot', event: 'preToolUse', handler: command })
  const decision = await firePreTool(adapter.ctx, {
    callId: 'c2',
    name: 'bash',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'allow')
})

test('copilot: ask is translated into a DSH ask with its reason', async (t) => {
  const command = hookScript(JSON.stringify({ permissionDecision: 'ask', permissionDecisionReason: 'confirm please' }))
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'copilot', event: 'preToolUse', handler: command })
  const decision = await firePreTool(adapter.ctx, {
    callId: 'c3',
    name: 'bash',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'ask')
  assert.equal(decision.reason, 'confirm please')
})

test('copilot: matchers are anchored regex, not substring matches', async (t) => {
  // Copilot compiles matchers as ^(?:PATTERN)$ and requires a full match, so
  // `bas` must NOT match `bash` — an unanchored implementation would be wrong.
  const command = hookScript(JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: 'matched' }))
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'copilot', event: 'preToolUse', matcher: 'bas', handler: command })

  const partial = await firePreTool(adapter.ctx, {
    callId: 'c4',
    name: 'bash',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(partial.kind, 'allow', 'a partial match must not fire (Copilot anchors the pattern)')

  const full = await firePreTool(adapter.ctx, {
    callId: 'c5',
    name: 'bas',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(full.kind, 'deny', 'an exact full match must fire')
})

test('copilot: an alternating matcher selects both tool names', async (t) => {
  const command = hookScript(JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: 'alternation' }))
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'copilot', event: 'preToolUse', matcher: 'bash|edit', handler: command })
  for (const name of ['bash', 'edit']) {
    const decision = await firePreTool(adapter.ctx, {
      callId: `c-${name}`,
      name,
      arguments: {},
      signal: new AbortController().signal,
    })
    assert.equal(decision.kind, 'deny', `${name} should be denied`)
  }
  const other = await firePreTool(adapter.ctx, {
    callId: 'c-view',
    name: 'view',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(other.kind, 'allow')
})

test('copilot: an invalid matcher skips the hook instead of matching everything', async (t) => {
  // Copilot skips an invalid regex entirely. Matching everything would turn a
  // typo into a blanket policy, which is the dangerous failure mode.
  const command = hookScript(JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: 'should not fire' }))
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'copilot', event: 'preToolUse', matcher: '([unclosed', handler: command })
  const decision = await firePreTool(adapter.ctx, {
    callId: 'c6',
    name: 'bash',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'allow', 'an invalid matcher must not fire the hook')
})

test('copilot: sessionStart injects its additionalContext as a sourced message', async (t) => {
  const command = hookScript(JSON.stringify({ additionalContext: 'copilot project context 9f3a' }))
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'copilot', event: 'sessionStart', handler: command })
  assert.equal(registration.seams[0], 'agent/created')

  const injected = []
  const agent = { id: 'sess-1', inject: (message) => injected.push(message) }
  // `agent/created` is a SERIAL event (no `next`), so it is dispatched with
  // parallel/emit — passing it to `waterfall` would treat the payload as the
  // final callback and never reach the listener.
  await adapter.ctx.parallel('agent/created', { agent, source: 'startup' })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(injected.length, 1, 'sessionStart context must be injected once')
  assert.equal(injected[0].source.kind, 'compat-adapter-copilot-context')
  const text = injected[0].content.map((block) => block.text).join('')
  assert.match(text, /9f3a/u)
})

test('copilot: postToolUse forwards additionalContext to the result pipeline', async (t) => {
  const command = hookScript(JSON.stringify({ additionalContext: 'retry with a smaller range' }))
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'copilot', event: 'postToolUse', handler: command })
  const decision = await adapter.ctx.waterfall(
    'tools/post-execute',
    { callId: 'p1', name: 'bash', arguments: {}, signal: new AbortController().signal },
    { isError: false, value: 'ok', content: [] },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  assert.deepEqual(decision.additionalContexts, ['retry with a smaller range'])
})

test('copilot: a blocked stop is reported but never falsely claims to force a turn', async (t) => {
  // DSH turn-stopping cannot force another turn, so the adapter must not
  // pretend. It logs the attempt; the capability table states the degradation.
  const command = hookScript(JSON.stringify({ decision: 'block', reason: 'keep going' }))
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'copilot', event: 'agentStop', handler: command })
  assert.ok(
    registration.degradations.some((line) => /runaway guard/iu.test(line)),
    'the agentStop mapping must state that no runaway guard is implemented',
  )
  // Firing must not throw and must not fabricate a continuation.
  await adapter.ctx.emit?.('agent/turn-stopping', {
    agent: { id: 's', session: { header: { cwd: '/tmp' } } },
    turn: 1,
    signal: new AbortController().signal,
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
})

test('copilot: every declared event now has a seam and states its losses', async (t) => {
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const copilot = (await import('../src/vendors/copilot.js')).default ?? (await import('../src/vendors/copilot.js'))
  for (const event of [...copilot.KNOWN_EVENTS]) {
    const result = await adapter.registerHook({ vendor: 'copilot', event, handler: 'echo x', id: `c-${event}` })
    assert.equal(result.capability, 'ADAPTED', `${event} should be executable`)
    assert.ok(result.degradations.length > 0, `${event} must state its losses`)
  }
  assert.equal(adapter.status().counts.unsupportedHooks, 0)
})

test('copilot: agentStop block really forces another step (not merely logged)', async (t) => {
  // The agent loop re-checks `inbox.nextStep.length === 0` right AFTER the
  // serial `agent/turn-stopping` dispatch, so appending a next-step message from
  // the listener keeps the turn going. This test drives that exact contract with
  // a fake agent whose inbox records the append.
  const command = hookScript(JSON.stringify({ decision: 'block', reason: 'keep working on the failing test' }))
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'copilot', event: 'agentStop', handler: command })
  assert.equal(registration.capability, 'ADAPTED')

  /** @type {Array<{target: string, text: string, source: object}>} */
  const appended = []
  const agent = {
    id: 'sess-stop',
    session: { header: { cwd: '/tmp' } },
    inbox: {
      nextStep: [],
      append(target, message) {
        appended.push({ target, text: message.content.map((block) => block.text ?? '').join(''), source: message.source })
        this.nextStep.push(message)
      },
    },
  }
  await adapter.ctx.parallel('agent/turn-stopping', { agent, turn: 3, signal: new AbortController().signal })
  await new Promise((resolve) => setTimeout(resolve, 150))

  assert.equal(appended.length, 1, 'a block decision must append exactly one next-step message')
  assert.equal(appended[0].target, 'next-step', 'the message must go to next-step so the loop rechecks it')
  assert.match(appended[0].text, /keep working on the failing test/u)
  assert.equal(appended[0].source.kind, 'compat-adapter-stop-continue')
  assert.equal(agent.inbox.nextStep.length, 1)
})

test('copilot: agentStop does not append when the hook allows the turn to end', async (t) => {
  const command = hookScript(JSON.stringify({ decision: 'allow' }))
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'copilot', event: 'agentStop', handler: command })
  const appended = []
  const agent = {
    id: 's',
    session: { header: { cwd: '/tmp' } },
    inbox: { nextStep: [], append: (target, message) => appended.push({ target, message }) },
  }
  await adapter.ctx.parallel('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(appended.length, 0)
})

test('copilot: agentStop runaway guard stops forcing after 8 consecutive blocks', async (t) => {
  // Copilot caps consecutive blocks at 8; without the cap an unconditional hook
  // would spin the agent forever.
  const command = hookScript(JSON.stringify({ decision: 'block', reason: 'again' }))
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'copilot', event: 'agentStop', handler: command })
  const appended = []
  const agent = {
    id: 's',
    session: { header: { cwd: '/tmp' } },
    inbox: { nextStep: [], append: (target, message) => appended.push(message) },
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await adapter.ctx.parallel('agent/turn-stopping', { agent, turn: 7, signal: new AbortController().signal })
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  assert.equal(appended.length, 8, `expected the 8-block cap, got ${appended.length} forced continuations`)
})

test('copilot: errorOccurred observes a real agent/error', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-copilot-err-'))
  const trace = join(dir, 'err.log')
  const command = join(dir, 'err.sh')
  writeFileSync(
    command,
    `#!/usr/bin/env bash\ncat > ${trace}\nprintf '%s' '{}'\nexit 0\n`,
    'utf8',
  )
  chmodSync(command, 0o755)
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'copilot', event: 'errorOccurred', handler: command })
  assert.equal(registration.capability, 'ADAPTED')
  assert.equal(registration.seams[0], 'agent/error')

  const error = new Error('model call blew up')
  await adapter.ctx.parallel('agent/error', {
    agent: { id: 'sess-err', session: { header: { cwd: dir } } },
    turn: 2,
    step: 1,
    error,
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  const payload = JSON.parse(readFileSync(trace, 'utf8'))
  assert.equal(payload.error.message, 'model call blew up')
  assert.equal(payload.error.name, 'Error')
  assert.equal(payload.turn, 2)
  assert.equal(payload.step, 1)
})

test('copilot: subagentStart injects context into the child agent', async (t) => {
  const command = hookScript(JSON.stringify({ additionalContext: 'follow the repo conventions' }))
  const { adapter, ctx, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'copilot', event: 'subagentStart', handler: command })
  assert.equal(registration.capability, 'ADAPTED')
  assert.equal(registration.seams[0], 'subagent/start')

  // DSH resolves the child through ctx.agents.get(runId) during the notification,
  // so the fixture registers a fake agent registry that returns the child.
  const injected = []
  const child = { id: 'child-1', inject: (message) => injected.push(message) }
  ctx.provide('agents', { get: (id) => (String(id) === 'child-1' ? child : undefined) })

  await ctx.parallel('subagent/start', { runId: 'run-1', provider: 'spawn', id: 'child-1', local: true })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(injected.length, 1, 'the child must receive exactly one context message')
  assert.equal(injected[0].source.kind, 'compat-adapter-subagent-context')
  assert.match(injected[0].content.map((block) => block.text).join(''), /repo conventions/u)
})

test('copilot: subagentStop observes the settled child', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-copilot-sub-'))
  const trace = join(dir, 'sub.log')
  const command = join(dir, 'sub.sh')
  writeFileSync(command, `#!/usr/bin/env bash\ncat > ${trace}\nprintf '%s' '{}'\nexit 0\n`, 'utf8')
  chmodSync(command, 0o755)
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'copilot', event: 'subagentStop', handler: command })
  assert.equal(registration.capability, 'ADAPTED')
  assert.equal(registration.seams[0], 'subagent/end')

  adapter.ctx.emit('subagent/end', {
    runId: 'run-1',
    provider: 'spawn',
    id: 'child-1',
    local: true,
    stopReason: 'end_turn',
    lastAssistantMessage: [{ type: 'text', text: 'child finished the job' }],
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  const payload = JSON.parse(readFileSync(trace, 'utf8'))
  assert.equal(payload.subagentId, 'child-1')
  assert.equal(payload.stopReason, 'end_turn')
  assert.match(payload.response, /child finished the job/u)
})

test('copilot: subagentStart injects nothing when the child agent is not visible', async (t) => {
  // A remote provider's child is not in ctx.agents during the notification, so
  // the mapping must skip injection instead of throwing or injecting nowhere.
  const command = hookScript(JSON.stringify({ additionalContext: 'should not be delivered' }))
  const { adapter, ctx, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'copilot', event: 'subagentStart', handler: command })
  // No 'agents' service registered at all.
  await adapter.ctx.parallel('subagent/start', { runId: 'run-9', provider: 'remote', id: 'unknown-child', local: false })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(ctx.get('agents'), undefined)
})
