/**
 * The builtin Copilot bridge as a UNIT.
 *
 * `smoke-copilot.test.js` proves the bridge works end to end through the
 * adapter. This file tests the bridge as the standalone artifact it claims to
 * be: the same contract the official bridges export, its own dialect parsing,
 * and the Copilot-specific rules that a generic bridge would get wrong.
 *
 * @module dsh-compat-adapter/test/bridge-copilot
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as bridge from '../src/bridges/copilot.js'

test('the bridge exports the same contract as the official DSH bridges', () => {
  // The official bridges export exactly these four names; a bridge built here
  // must be mountable the same way, or it is not a bridge.
  assert.equal(bridge.name, 'hooks-copilot')
  assert.ok(Array.isArray(bridge.inject))
  assert.deepEqual([...bridge.inject], ['shell', 'sessionProjections'], 'inject must match the official bridges')
  assert.equal(typeof bridge.Config, 'function')
  assert.equal(typeof bridge.apply, 'function')
})

test('the Config validator requires a config path', () => {
  const ok = bridge.Config({ configPath: '/tmp/x.json' })
  assert.equal(ok.configPath, '/tmp/x.json')
  assert.equal(typeof ok.defaultTimeoutMs, 'number')
  assert.throws(() => bridge.Config({}), /configPath/u)
})

test('commandFor honors Copilot field precedence per platform', () => {
  // Copilot: bash (Unix), powershell (Windows), command as cross-platform
  // fallback. Picking the wrong one silently runs the wrong script.
  const entry = { bash: 'unix-cmd', powershell: 'win-cmd', command: 'fallback' }
  assert.equal(bridge.commandFor(entry, 'linux'), 'unix-cmd')
  assert.equal(bridge.commandFor(entry, 'darwin'), 'unix-cmd')
  assert.equal(bridge.commandFor(entry, 'win32'), 'win-cmd')
  // With only the fallback present, it is used on every platform.
  assert.equal(bridge.commandFor({ command: 'fallback' }, 'linux'), 'fallback')
  assert.equal(bridge.commandFor({ command: 'fallback' }, 'win32'), 'fallback')
  // exec+args renders an argv line with shell-safety quoting.
  assert.equal(bridge.commandFor({ exec: '/bin/tool', args: ['a', 'b c'] }, 'linux'), "/bin/tool a 'b c'")
  // No command field at all is undefined, never an empty command.
  assert.equal(bridge.commandFor({}, 'linux'), undefined)
})

test('parseCopilotConfig reads Copilot\'s own envelope and skips non-command hooks', () => {
  const parsed = bridge.parseCopilotConfig({
    version: 1,
    hooks: {
      preToolUse: [
        { type: 'command', bash: 'guard.sh', matcher: 'bash', timeoutSec: 30 },
        // Non-command hook families are parsed-and-skipped, like the official bridges.
        { type: 'prompt', prompt: 'ignore me' },
        { type: 'http', url: 'https://example.com' },
        // A malformed entry is dropped while its siblings survive.
        { type: 'command' },
      ],
      sessionStart: [{ command: 'ctx.sh' }],
    },
  })
  assert.equal(parsed.disabled, false)
  assert.equal(parsed.hooks.preToolUse.length, 1, 'only the valid command entry survives')
  assert.equal(parsed.hooks.preToolUse[0].matcher, 'bash')
  assert.equal(parsed.hooks.preToolUse[0].hooks[0].command, 'guard.sh')
  assert.equal(parsed.hooks.preToolUse[0].hooks[0].timeoutSec, 30)
  assert.equal(parsed.hooks.sessionStart[0].hooks[0].command, 'ctx.sh')
})

test('parseCopilotConfig honors disableAllHooks and the timeoutSec precedence', () => {
  const disabled = bridge.parseCopilotConfig({ version: 1, disableAllHooks: true, hooks: { preToolUse: [{ command: 'x' }] } })
  assert.equal(disabled.disabled, true)
  // `timeout` is an alias used only when `timeoutSec` is absent.
  const parsed = bridge.parseCopilotConfig({
    version: 1,
    hooks: { preToolUse: [{ command: 'x', timeout: 10, timeoutSec: 20 }, { command: 'y', timeout: 10 }] },
  })
  assert.equal(parsed.hooks.preToolUse[0].hooks[0].timeoutSec, 20)
  assert.equal(parsed.hooks.preToolUse[1].hooks[0].timeoutSec, 10)
})

test('normalizeDialect decodes the TOP-LEVEL decision the shared parser misses', () => {
  // This is the reason the bridge exists: DSH's decoder reads only
  // hookSpecificOutput.permissionDecision, so a Copilot deny would be read as
  // "no decision" without this step.
  const deny = bridge.normalizeDialect({
    exitCode: 0,
    stdout: JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: 'no writes' }),
    stderr: '',
  })
  assert.equal(deny.decision, 'deny')
  assert.equal(deny.reason, 'no writes')

  const ask = bridge.normalizeDialect({ exitCode: 0, stdout: JSON.stringify({ permissionDecision: 'ask' }), stderr: '' })
  assert.equal(ask.decision, 'ask')

  // A Claude-shaped payload is left to the shared decoder.
  const claude = { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } }), stderr: '', decision: 'deny' }
  assert.equal(bridge.normalizeDialect(claude).decision, 'deny')

  // modifiedArgs is surfaced for the warning path (parsed, not honored).
  const modified = bridge.normalizeDialect({
    exitCode: 0,
    stdout: JSON.stringify({ permissionDecision: 'allow', modifiedArgs: { a: 1 } }),
    stderr: '',
  })
  assert.deepEqual(modified.updatedInput, { a: 1 })
})

test('joinedContext joins merged context and ignores empty contributions', () => {
  // mergeHookOutputs returns an ARRAY when several hooks contribute, but the
  // injection path needs one string.
  assert.equal(bridge.joinedContext('single'), 'single')
  assert.equal(bridge.joinedContext(['a', 'b']), 'a\n\nb')
  assert.equal(bridge.joinedContext(['a', '  ', 'b']), 'a\n\nb')
  assert.equal(bridge.joinedContext([]), undefined)
  assert.equal(bridge.joinedContext('   '), undefined)
  assert.equal(bridge.joinedContext(undefined), undefined)
  assert.equal(bridge.joinedContext(42), undefined)
})

test('the builtin matcher is ANCHORED, unlike the shared codex mode', async () => {
  // Copilot compiles matchers as ^(?:PATTERN)$ and requires a full match. The
  // shared 'codex' mode is unanchored, so `bas` would wrongly fire for `bash`.
  const { loadCorpus } = await import('../src/bridges/shared.js')
  const corpus = await loadCorpus()
  assert.equal(corpus.matches('bas', 'bash'), false, 'a partial match must not fire')
  assert.equal(corpus.matches('bash', 'bash'), true)
  assert.equal(corpus.matches('bash|edit', 'bash'), true)
  assert.equal(corpus.matches('bash|edit', 'edit'), true)
  assert.equal(corpus.matches('bash|edit', 'view'), false)
  // An invalid pattern skips the hook rather than matching everything.
  assert.equal(corpus.matches('([unclosed', 'bash'), false)
  // No matcher is match-all, as Copilot documents.
  assert.equal(corpus.matches(undefined, 'anything'), true)
  assert.equal(corpus.matches('', 'anything'), true)
  assert.equal(corpus.matches('*', 'anything'), true)
})

test('apply tolerates a missing config file without throwing', () => {
  // A bad config path must not crash the composition: the bridge logs and
  // mounts nothing, exactly like the official bridges' try/catch around the read.
  const warnings = []
  const ctx = { logger: { warn: (line) => warnings.push(line), info: () => {} }, on: () => {} }
  assert.doesNotThrow(() => bridge.apply(ctx, { configPath: join(mkdtempSync(join(tmpdir(), 'dsh-br-')), 'missing.json') }))
  assert.ok(warnings.some((line) => /cannot read/u.test(line)))
})

test('apply honors disableAllHooks by mounting nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-br-off-'))
  const configPath = join(dir, 'hooks.json')
  writeFileSync(configPath, JSON.stringify({ version: 1, disableAllHooks: true, hooks: { preToolUse: [{ command: 'x' }] } }), 'utf8')
  let listeners = 0
  const ctx = { logger: { warn: () => {}, info: () => {} }, on: () => { listeners += 1 } }
  bridge.apply(ctx, { configPath })
  assert.equal(listeners, 0, 'a disabled config must register no listener')
})

test('DIALECT_LIMITS records what the bridge parses but does not honor', () => {
  // The one honest limitation must be declared, not buried in code.
  assert.ok(bridge.DIALECT_LIMITS.unhonored.includes('modifiedArgs'))
  assert.equal(bridge.DIALECT_LIMITS.decisionLocation, 'top-level permissionDecision')
  assert.ok(bridge.DIALECT_LIMITS.commandFields.includes('bash'))
  assert.ok(bridge.DIALECT_LIMITS.commandFields.includes('powershell'))
  assert.ok(bridge.DIALECT_LIMITS.commandFields.includes('command'))
})
