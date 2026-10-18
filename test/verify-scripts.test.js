/**
 * Invariants of the two end-to-end verification scripts.
 *
 * These scripts are the only evidence that the plugin works against a *real*
 * launched profile, so a defect in them is worse than a defect in the adapter:
 * it produces a confident but wrong verdict. Four such defects were found and
 * fixed together, and each one is pinned here:
 *
 * 1. `verify-installed.mjs` did not hold stdin open, so a mounted SDK app's
 *    `exitOnStdinEnd` unloaded the composition mid-check and the next call threw
 *    `ADAPTER_DISPOSED` — reported as a plugin failure.
 * 2. Its fake agent had no `session`, so DSH's own GoalService
 *    (`WeakMap.set(agent.session, ...)`) threw inside the dispatch.
 * 3. It drove `agent/created` with a synthetic `ctx.waterfall`, but DSH
 *    dispatches it with `ctx.serial` through the real registry — a synthetic
 *    dispatch silently reported "0 injected" on profiles that mount the scope
 *    plugin while the product path injected correctly.
 * 4. It read the injected-message count immediately, but rule injection resolves
 *    the message constructor lazily, so it counted 0.
 * 5. Its deny script kept no side-channel, so "the hook command never ran"
 *    (an environment limit) was indistinguishable from "the hook ran and its
 *    decision was ignored" (a plugin bug).
 *
 * Static assertions are used deliberately: the scripts boot a real Harness and
 * cannot run inside `npm test`, and the bug classes above are exactly the ones a
 * text-level guard catches.
 *
 * @module dsh-compat-adapter/test/verify-scripts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = new URL('..', import.meta.url).pathname

const live = readFileSync(join(ROOT, 'scripts/verify-live.mjs'), 'utf8')
const installed = readFileSync(join(ROOT, 'scripts/verify-installed.mjs'), 'utf8')

test('both verification scripts hold stdin open so a mounted SDK app cannot unload mid-check', () => {
  for (const [name, source, marker] of [
    ['verify-live.mjs', live, 'DSH_VERIFY_LIVE_CHILD'],
    ['verify-installed.mjs', installed, 'DSH_VERIFY_INSTALLED_CHILD'],
  ]) {
    assert.ok(source.includes(marker), `${name} lost its child-process marker for the stdin-holding re-exec`)
    assert.ok(/stdio:\s*\[\s*'pipe'/.test(source), `${name} no longer spawns the child with a pipe on stdin`)
    assert.ok(source.includes('keepAlive'), `${name} no longer keeps a handle alive to hold the stdin pipe open`)
  }
})

test('verify-installed drives the real agent registry, not only a synthetic dispatch', () => {
  // `agent/created` is dispatched by AgentService through `ctx.serial` on the
  // agent's scope carrier; a bare `ctx.waterfall` is not the product path.
  assert.ok(installed.includes("ctx.get('agents')"), 'verify-installed no longer looks up the real agents service')
  assert.ok(installed.includes('agents.register('), 'verify-installed no longer drives the real agents.register path')
  assert.ok(installed.includes("ctx.serial("), 'verify-installed lost its fallback serial dispatch')
})

test('verify-installed fakes an agent DSH will actually accept', () => {
  // GoalService does WeakMap.set(agent.session, ...), and DSH asserts
  // agent.id === session.id; the Claude bridge reads session.header.id/cwd.
  assert.ok(/session:\s*fakeSession/.test(installed), 'the fake agent no longer carries a session')
  assert.ok(installed.includes('header:'), 'the fake session no longer carries the header the bridges read')
  assert.ok(installed.includes('stubId'), 'agent and session ids are no longer derived from one constant')
})

test('verify-installed settles the lazy rule injection before asserting the count', () => {
  const settle = installed.match(/setTimeout\(resolve,\s*\d+\)/)
  assert.ok(settle, 'verify-installed no longer waits for the lazily-resolved message constructor')
})

test('verify-installed attributes a hook failure instead of reporting a bare allow', () => {
  // Without a trace file, "the executor refused the command" reads as a plugin bug.
  assert.ok(installed.includes('traceFile'), 'verify-installed no longer records whether the hook command ran')
  assert.ok(installed.includes('hookRan'), 'verify-installed no longer reports whether the hook command ran')
  assert.ok(
    installed.includes('danger-full-access'),
    'the failure message no longer names the environment escape hatch that distinguishes the two cases',
  )
})
