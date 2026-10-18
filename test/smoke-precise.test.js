/**
 * Precise-seam smoke tests.
 *
 * These four mappings replaced earlier approximations. The point of the file is
 * to prove each one rides a REAL DSH seam carrying real data, not a tool-call
 * inference — the exact upgrade the "reduce losses" work was for.
 *
 * @module dsh-compat-adapter/test/smoke-precise
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAdapterFixture } from './helpers/harness.js'

/**
 * Write a hook that records its stdin to a file and exits 0.
 *
 * @param {string} dir - directory for the script and its trace.
 * @param {string} name - base name.
 * @returns {{command: string, trace: string}} script path and trace path.
 */
function recordingHook(dir, name) {
  const trace = join(dir, `${name}.stdin.json`)
  const command = join(dir, `${name}.sh`)
  writeFileSync(command, `#!/usr/bin/env bash\ncat > ${trace}\nprintf '%s' '{}'\nexit 0\n`, 'utf8')
  chmodSync(command, 0o755)
  return { command, trace }
}

test('FileChanged reads the real changed-file summary, not a tool-call guess', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-filechg-'))
  const { command, trace } = recordingHook(dir, 'filechanged')
  const { adapter, ctx, dispose } = await createAdapterFixture()
  t.after(dispose)

  // A stub workspaceChanges service serving the summary for one turn.
  ctx.provide('workspaceChanges', {
    summary(sessionId, seq) {
      if (String(sessionId) !== 'sess-w' || seq !== 42) return undefined
      return {
        turn: 3,
        cwd: dir,
        files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
        total: 4,
        added: 12,
        deleted: 3,
      }
    },
  })

  const registration = await adapter.registerHook({ vendor: 'claude', event: 'FileChanged', handler: command })
  assert.equal(registration.capability, 'ADAPTED')
  assert.equal(registration.seams[0], 'session/event')

  adapter.ctx.emit('session/event', { id: 'sess-w', header: { cwd: dir } }, {
    type: 'workspace/changes', seq: 42, time: Date.now(), data: { turn: 3 },
  })
  await new Promise((resolve) => setTimeout(resolve, 250))

  const payload = JSON.parse(readFileSync(trace, 'utf8'))
  assert.equal(payload.turn, 3)
  assert.deepEqual(payload.paths, ['src/a.ts', 'src/b.ts'], 'the real changed paths must reach the hook')
  assert.equal(payload.total, 4)
  assert.equal(payload.added, 12)
  assert.equal(payload.deleted, 3)
})

test('InstructionsLoaded reports the files discovery actually found', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-instr-'))
  writeFileSync(join(dir, 'CLAUDE.md'), '# real instruction file\n', 'utf8')
  const { command, trace } = recordingHook(dir, 'instr')
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'claude', event: 'InstructionsLoaded', handler: command })
  assert.equal(registration.capability, 'ADAPTED')

  await adapter.ctx.parallel('session/created', { id: 'sess-i', header: { cwd: dir } })
  await new Promise((resolve) => setTimeout(resolve, 400))

  const payload = JSON.parse(readFileSync(trace, 'utf8'))
  assert.ok(Array.isArray(payload.instructionFiles), 'the payload must carry a real file list')
  // Discovery is real: the CLAUDE.md written above must appear.
  assert.ok(
    payload.instructionFiles.some((path) => String(path).includes('CLAUDE')),
    `expected the real CLAUDE.md in the discovered list, got ${JSON.stringify(payload.instructionFiles)}`,
  )
})

test('message.updated rides agent/inbox/inserted with the real message', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-msg-'))
  const { command, trace } = recordingHook(dir, 'msg')
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)
  const registration = await adapter.registerHook({ vendor: 'opencode', event: 'message.updated', handler: command })
  assert.equal(registration.capability, 'ADAPTED')
  assert.equal(registration.seams[0], 'agent/inbox/inserted')

  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const message = createUserMessage({ content: [{ type: 'text', text: 'the real prompt text' }], source: { kind: 'user' } })
  adapter.ctx.emit('agent/inbox/inserted', {
    agent: { id: 'sess-m', session: { header: { cwd: dir } } },
    message,
  })
  await new Promise((resolve) => setTimeout(resolve, 250))

  const payload = JSON.parse(readFileSync(trace, 'utf8'))
  assert.equal(payload.messageId, String(message.id), 'the real message id must be reported')
  assert.match(payload.text, /the real prompt text/u)
  assert.equal(payload.role, 'user')
})

test('copilot preCompact and claude PostCompact stay on the compaction events', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-comp-'))
  const pre = recordingHook(dir, 'pre')
  const post = recordingHook(dir, 'post')
  const { adapter, dispose } = await createAdapterFixture()
  t.after(dispose)

  await adapter.registerHook({ vendor: 'copilot', event: 'preCompact', handler: pre.command })
  await adapter.registerHook({ vendor: 'claude', event: 'PostCompact', handler: post.command })

  const session = { id: 'sess-c', header: { cwd: dir } }
  adapter.ctx.emit('session/event', session, {
    type: 'compaction/start', seq: 1, time: Date.now(), data: { compactionId: 'cc', turn: null },
  })
  adapter.ctx.emit('session/event', session, {
    type: 'compaction/summary', seq: 2, time: Date.now(),
    data: { compactionId: 'cc', summary: [{ type: 'text', text: 'S U M M A R Y' }], shadowedSeqs: [], shadowedTokenCount: 1, provider: 'p', model: 'm', rawOutput: [] },
  })
  adapter.ctx.emit('session/event', session, {
    type: 'compaction/end', seq: 3, time: Date.now(), data: { compactionId: 'cc', turn: null },
  })
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.equal(JSON.parse(readFileSync(pre.trace, 'utf8')).compactionId, 'cc')
  assert.match(JSON.parse(readFileSync(post.trace, 'utf8')).compactSummary, /S U M M A R Y/u)
})

test('every translation point is wired in BOTH directions', async () => {
  // Regression guard: a point with a service branch but no NATIVE_TRANSLATIONS
  // entry is unreachable (the vendor table resolves the point, finds no
  // mapping, and refuses). That exact bug shipped twice during development.
  const { NATIVE_TRANSLATIONS } = await import('../src/translate.js')
  const service = readFileSync(new URL('../src/service.js', import.meta.url).pathname, 'utf8')
  const branches = [...service.matchAll(/translation\.point === '([^']+)'/gu)].map((match) => match[1])
  const unique = [...new Set(branches)]

  const missingBranch = Object.keys(NATIVE_TRANSLATIONS).filter((point) => !unique.includes(point))
  assert.deepEqual(missingBranch, [], 'a declared translation point must have a service branch')

  const orphanBranch = unique.filter((point) => NATIVE_TRANSLATIONS[point] === undefined)
  assert.deepEqual(orphanBranch, [], 'a service branch must correspond to a declared translation point')
})

test('every vendor point resolves to a known translation point', async () => {
  const { NATIVE_TRANSLATIONS } = await import('../src/translate.js')
  const { buildMatrix } = await import('../src/matrix.js')
  for (const vendor of buildMatrix()) {
    for (const event of vendor.hooks) {
      if (event.route !== 'native-translate') continue
      assert.ok(
        NATIVE_TRANSLATIONS[event.point] !== undefined,
        `${vendor.vendor} ${event.event} names unknown translation point ${event.point}`,
      )
    }
  }
})
