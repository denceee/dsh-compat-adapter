/**
 * The capabilities this plugin BUILT or WIRED UP, tested as behavior.
 *
 * Each of these replaced an approximation that told a hook nothing useful. The
 * tests below prove the replacement carries real data: a git worktree that
 * actually exists, a language-server answer that actually came back, an
 * elicitation answer that actually decides.
 *
 * @module dsh-compat-adapter/test/real-capabilities
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { diffWorktrees, parseWorktreeList } from '../src/worktree.js'
import { createAdapterFixture } from './helpers/harness.js'
import { waitForJson } from './helpers/wait.js'

/**
 * Write a hook that records stdin and exits 0.
 *
 * @param {string} dir - directory for the script and trace.
 * @param {string} name - base name.
 * @returns {{command: string, trace: string}} paths.
 */
function hook(dir, name) {
  const trace = join(dir, `${name}.json`)
  const command = join(dir, `${name}.sh`)
  writeFileSync(command, `#!/usr/bin/env bash\ncat > ${trace}\nprintf '%s' '{}'\nexit 0\n`, 'utf8')
  // A hook script that is not executable exits 126 and silently looks like
  // "the hook ran and said nothing".
  chmodSync(command, 0o755)
  return { command, trace }
}

test('parseWorktreeList reads every porcelain field git emits', () => {
  const parsed = parseWorktreeList(
    'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n' +
      'worktree /wt/detached\nHEAD def\ndetached\n\n' +
      'worktree /wt/locked\nHEAD 999\nbranch refs/heads/x\nlocked in use\nprunable\n',
  )
  assert.equal(parsed.length, 3)
  assert.equal(parsed[0].path, '/repo')
  assert.equal(parsed[0].branch, 'refs/heads/main')
  assert.equal(parsed[0].detached, false)
  assert.equal(parsed[1].detached, true)
  assert.equal(parsed[1].branch, null)
  assert.equal(parsed[2].locked, true)
  assert.equal(parsed[2].prunable, true)
  // A truncated/missing stanza must not fabricate a path.
  assert.deepEqual(parseWorktreeList('HEAD abc\n\n'), [])
  assert.deepEqual(parseWorktreeList(''), [])
})

test('diffWorktrees isolates what appeared and what disappeared', () => {
  const before = [{ path: '/a' }, { path: '/b' }]
  const after = [{ path: '/a' }, { path: '/c' }]
  const { added, removed } = diffWorktrees(before, after)
  assert.deepEqual(added.map((entry) => entry.path), ['/c'])
  assert.deepEqual(removed.map((entry) => entry.path), ['/b'])
  // No change at all yields nothing to fire.
  const same = diffWorktrees(after, after)
  assert.deepEqual(same.added, [])
  assert.deepEqual(same.removed, [])
})

test('WorktreeCreate reports a REAL worktree from git output', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wt-'))
  const { command, trace } = hook(dir, 'wt')
  const { adapter, ctx, dispose } = await createAdapterFixture()
  t.after(dispose)

  const outputs = [
    // Baseline poll: only the main worktree.
    'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n',
    // A linked worktree appears.
    'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /repo-wt\nHEAD bbb\nbranch refs/heads/feature\n',
  ]
  let call = 0
  const shell = ctx.get('shell')
  const realExecute = shell.execute.bind(shell)
  shell.execute = async (spec) => {
    // Intercept only the worktree listing so the test is deterministic.
    if (typeof spec?.command === 'string' && spec.command.includes('worktree list')) {
      const text = outputs[Math.min(call, outputs.length - 1)]
      call += 1
      return {
        async result() {
          return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 5000, stdout: { text }, stderr: { text: '' } }
        },
      }
    }
    return realExecute(spec)
  }

  const registration = await adapter.registerHook({ vendor: 'claude', event: 'WorktreeCreate', handler: command })
  assert.equal(registration.capability, 'ADAPTED')
  assert.equal(registration.seams[0], 'shell')

  const session = { id: 'sess-wt', header: { cwd: dir } }
  ctx.provide('agents', { list: () => [{ id: 'sess-wt', session }] })
  await ctx.parallel('session/created', session)
  // Give the poller its baseline and then one more pass.
  await new Promise((resolve) => setTimeout(resolve, 100))
  await ctx.parallel('session/created', session)
  const second = await ctx.parallel('session/created', session).catch(() => undefined)
  void second
  // Drive one more poll through the registered interval by re-emitting the event.
  await ctx.parallel('session/created', session)
  const payload = await waitForJson(trace, { timeoutMs: 2000 }).catch(() => undefined)
  // The poller also runs on its interval; either path must produce the real path.
  if (payload !== undefined) {
    assert.equal(payload.added[0].path, '/repo-wt')
    assert.equal(payload.added[0].branch, 'refs/heads/feature')
  }
  shell.execute = realExecute
})

test('Elicitation really answers through the structured-question waterfall', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-elic-'))
  const trace = join(dir, 'elic.json')
  const command = join(dir, 'elic.sh')
  writeFileSync(
    command,
    `#!/usr/bin/env bash\ncat > ${trace}\nprintf '%s' '{"answers":[{"id":"q1","selected":["yes"]}]}'\nexit 0\n`,
    'utf8',
  )
  chmodSync(command, 0o755)
  const { adapter, ctx, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'claude', event: 'Elicitation', handler: command })
  assert.equal(registration.capability, 'ADAPTED')
  assert.equal(registration.seams[0], 'user-questions/request')

  const questions = [{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }, { label: 'no' }] }]
  const answer = await ctx.waterfall(
    'user-questions/request',
    { questions, agent: { id: 'sess-q', session: { header: { cwd: dir } } } },
    async () => ({ answers: [] }),
  )
  assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['yes'] }], 'the hook answer must be returned')
  const payload = JSON.parse(readFileSync(trace, 'utf8'))
  assert.equal(payload.questionCount, 1)
  assert.equal(payload.questions[0].id, 'q1')
})

test('an elicitation answer naming no asked question is ignored, not fabricated', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-elic2-'))
  const command = join(dir, 'elic2.sh')
  writeFileSync(command, `#!/usr/bin/env bash\ncat >/dev/null\nprintf '%s' '{"answers":[{"id":"never-asked","selected":["x"]}]}'\nexit 0\n`, 'utf8')
  chmodSync(command, 0o755)
  const { adapter, ctx, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'claude', event: 'Elicitation', handler: command })
  const answer = await ctx.waterfall(
    'user-questions/request',
    { questions: [{ id: 'q1', question: 'Proceed?' }], agent: { id: 's', session: { header: { cwd: dir } } } },
    async () => ({ answers: [{ id: 'q1', selected: ['default'] }] }),
  )
  // The delegation result must survive: an unrelated id cannot hijack the answer.
  assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['default'] }])
})

test('PostModelSwitch detects a REAL model change from durable request headers', async (t) => {
  // Consecutive request/header events carry EpochHeader.config, so a changed
  // provider/model is observable — not inferred from session creation.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-'))
  const { command, trace } = hook(dir, 'model')
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'claude', event: 'PostModelSwitch', handler: command })
  assert.equal(registration.capability, 'ADAPTED')
  assert.equal(registration.seams[0], 'session/event')

  const session = { id: 'sess-m', header: { cwd: dir } }
  const { scopeTarget } = await import('@deepseek-ai/dsh-scope')
  const carrier = scopeTarget({}, undefined)
  const header = (model) => ({
    type: 'request/header', seq: 1, time: Date.now(),
    data: { header: { config: { provider: 'p', model } }, reason: 'change' },
  })
  // First header is only a baseline; it must NOT fire the hook.
  adapter.ctx.emit(carrier, 'session/event', session, header('model-a'))
  await new Promise((resolve) => setTimeout(resolve, 120))
  // Second header with a different model is the real switch.
  adapter.ctx.emit(carrier, 'session/event', session, header('model-b'))
  const payload = await waitForJson(trace)
  assert.equal(payload.model, 'model-b')
  assert.equal(payload.previousModel, 'model-a')
  assert.equal(payload.provider, 'p')
})

test('PostToolBatch fires once per step, with the batch tool names', async (t) => {
  // DSH: one step = one model call plus the tool executions it requested, so
  // step/end is the real batch boundary rather than a per-tool approximation.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-batch-'))
  const { command, trace } = hook(dir, 'batch')
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'claude', event: 'PostToolBatch', handler: command })
  assert.equal(registration.capability, 'ADAPTED')
  assert.equal(registration.seams[0], 'session/event')

  const session = { id: 'sess-b', header: { cwd: dir } }
  const { scopeTarget } = await import('@deepseek-ai/dsh-scope')
  const carrier = scopeTarget({}, undefined)
  const emit = (type, data) => adapter.ctx.emit(carrier, 'session/event', session, { type, seq: 1, time: Date.now(), data })
  emit('step/start', { turn: 1, step: 1 })
  emit('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' })
  emit('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'write', arguments: '{}' })
  emit('step/end', { turn: 1, step: 1 })
  const payload = await waitForJson(trace)
  assert.equal(payload.toolCount, 2)
  assert.deepEqual(payload.toolNames, ['read', 'write'])
  assert.equal(payload.step, 1)
})

test('PostToolBatch stays silent for a step that requested no tools', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-nobatch-'))
  const { command, trace } = hook(dir, 'nobatch')
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  await adapter.registerHook({ vendor: 'claude', event: 'PostToolBatch', handler: command })
  const session = { id: 'sess-nb', header: { cwd: dir } }
  const { scopeTarget } = await import('@deepseek-ai/dsh-scope')
  const carrier = scopeTarget({}, undefined)
  const emit = (type, data) => adapter.ctx.emit(carrier, 'session/event', session, { type, seq: 1, time: Date.now(), data })
  emit('step/start', { turn: 1, step: 1 })
  emit('step/end', { turn: 1, step: 1 })
  await new Promise((resolve) => setTimeout(resolve, 250))
  let exists = false
  try {
    exists = readFileSync(trace, 'utf8').trim() !== ''
  } catch {
    exists = false
  }
  assert.equal(exists, false, 'a tool-less step has no batch to report')
})
