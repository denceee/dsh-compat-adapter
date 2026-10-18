/**
 * Vendor capability tables: the honest per-event grading.
 *
 * Each vendor's table is asserted against the SHIPPED bridge coverage, not
 * against the vendor's documented event list. A test that a documented event is
 * UNSUPPORTED is as important as one that a supported event is ADAPTED: it is
 * what stops the adapter from growing fake capabilities.
 *
 * @module dsh-compat-adapter/test/vendors.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CAPABILITY } from '../src/capability.js'
import { VENDORS, vendorModule, vendorNames } from '../src/vendors/index.js'
import * as claude from '../src/vendors/claude.js'
import * as codex from '../src/vendors/codex.js'
import * as workbuddy from '../src/vendors/workbuddy.js'
import * as opencode from '../src/vendors/opencode.js'
import * as copilot from '../src/vendors/copilot.js'

/** The five independent vendor adapters, one per declared vendor. */
const MODULES = { claude, codex, workbuddy, opencode, copilot }

test('exactly five vendor adapters, each with a frozen hook table', () => {
  assert.deepEqual([...VENDORS], ['claude', 'codex', 'workbuddy', 'opencode', 'copilot'])
  for (const vendor of VENDORS) {
    const module = MODULES[vendor]
    assert.equal(module.VENDOR, vendor)
    assert.equal(Object.isFrozen(module.HOOKS), true, `${vendor} hook table must be frozen`)
    assert.ok(Object.keys(module.HOOKS).length > 0, `${vendor} has no hook events`)
    assert.ok(Object.isFrozen(module.RULES), true, `${vendor} rules table must be frozen`)
    assert.equal(module.RULES.capability, CAPABILITY.CARRY, `${vendor} rules must be CARRY`)
  }
})

test('vendor aliases resolve, unknown vendors do not', () => {
  assert.equal(vendorModule('claude'), claude)
  assert.equal(vendorModule('claude-code'), claude)
  assert.equal(vendorModule('codex'), codex)
  assert.equal(vendorModule('workbuddy'), workbuddy)
  assert.equal(vendorModule('codebuddy'), workbuddy)
  assert.equal(vendorModule('opencode'), opencode)
  assert.equal(vendorModule('copilot'), copilot)
  assert.equal(vendorModule('github-copilot'), copilot)
  assert.equal(vendorModule('CLAUDE'), claude, 'vendor lookup is case-insensitive')
  assert.equal(vendorModule('cursor'), undefined)
  assert.equal(vendorModule(''), undefined)
  assert.ok(vendorNames().includes('claude'))
})

test('every UNSUPPORTED entry states a specific reason', () => {
  for (const vendor of VENDORS) {
    for (const [event, mapping] of Object.entries(MODULES[vendor].HOOKS)) {
      if (mapping.capability !== CAPABILITY.UNSUPPORTED) continue
      assert.equal(typeof mapping.reason, 'string', `${vendor} ${event} needs a reason`)
      assert.ok(mapping.reason.length > 40, `${vendor} ${event} reason is too vague: ${mapping.reason}`)
      assert.deepEqual([...mapping.seams], [], `${vendor} ${event} is UNSUPPORTED but claims seams`)
    }
  }
})

test('every ADAPTED entry lists degradations and names its seams', () => {
  for (const vendor of VENDORS) {
    for (const [event, mapping] of Object.entries(MODULES[vendor].HOOKS)) {
      if (mapping.capability !== CAPABILITY.ADAPTED) continue
      assert.ok(mapping.degradations.length > 0, `${vendor} ${event} claims ADAPTED without degradations`)
      assert.ok(mapping.seams.length > 0, `${vendor} ${event} claims ADAPTED without a DSH seam`)
      assert.ok(
        ['official-bridge', 'builtin-bridge', 'native-seam', 'native-translate'].includes(mapping.route),
        `${vendor} ${event} has an unknown route`,
      )
      if (mapping.route === 'official-bridge' || mapping.route === 'builtin-bridge') {
        assert.ok(['claude', 'codex', 'copilot'].includes(mapping.bridge), `${vendor} ${event} names an unknown bridge`)
      }
    }
  }
})

test('no vendor claims DIRECT: every supported event is a declared approximation', () => {
  for (const vendor of VENDORS) {
    for (const [event, mapping] of Object.entries(MODULES[vendor].HOOKS)) {
      assert.notEqual(mapping.capability, CAPABILITY.DIRECT, `${vendor} ${event} claims DIRECT; no bridge is byte-faithful`)
    }
  }
})

test('Claude Code: only the seven shipped-bridge events are executable', () => {
  const bridged = Object.entries(claude.HOOKS)
    .filter(([, mapping]) => mapping.route === 'official-bridge')
    .map(([event]) => event)
    .sort()
  assert.deepEqual(bridged, ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'])

  const native = Object.entries(claude.HOOKS)
    .filter(([, mapping]) => mapping.route === 'native-seam')
    .map(([event]) => event)
    .sort()
  assert.deepEqual(native, ['PreCompact', 'SessionEnd'])

  // Compaction is a service call, not a cancellable waterfall: the mapping must
  // say it cannot veto, or a preset author would believe they can stop it.
  assert.ok(claude.HOOKS.PreCompact.degradations.some((line) => /cannot veto/iu.test(line)))
})

test('Claude Code: events outside the shipped bridge are translated, not faked', () => {
  // The bridge covers 7 events; everything else must be mounted by THIS adapter
  // (native-translate) rather than pretending the bridge handles it.
  for (const event of ['PermissionRequest', 'PermissionDenied', 'PostToolUseFailure', 'Notification', 'TaskCreated', 'TaskCompleted', 'FileChanged', 'Elicitation']) {
    const mapping = claude.HOOKS[event]
    assert.equal(mapping.capability, CAPABILITY.ADAPTED, `${event} should be executable`)
    assert.equal(mapping.route, 'native-translate', `${event} must not claim the bridge`)
    assert.ok(mapping.degradations.length > 0, `${event} must state its losses`)
  }
  // The approval seam is the one place a permission hook really decides.
  assert.equal(claude.HOOKS.PermissionRequest.point, 'approval/request')
})

test('Codex: five bridged events, and ask/updatedInput losses are stated', () => {
  const bridged = Object.entries(codex.HOOKS)
    .filter(([, mapping]) => mapping.route === 'official-bridge')
    .map(([event]) => event)
    .sort()
  assert.deepEqual(bridged, ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'])
  assert.ok(codex.HOOKS.PreToolUse.degradations.some((line) => /ask/iu.test(line)), 'Codex PreToolUse must state that ask is unsupported')
  assert.ok(codex.HOOKS.PreToolUse.degradations.some((line) => /updatedInput/iu.test(line)), 'Codex PreToolUse must state that updatedInput is not honored')
  // Codex's own bridge does not implement these, but DSH exposes subagent
  // lifecycle seams, so the adapter observes them natively (declared as such).
  assert.equal(codex.HOOKS.SubagentStart.capability, CAPABILITY.ADAPTED)
  assert.equal(codex.HOOKS.SubagentStart.route, 'native-translate')
  assert.equal(codex.HOOKS.SubagentStop.capability, CAPABILITY.ADAPTED)
  assert.notEqual(codex.HOOKS.SubagentStart.route, 'official-bridge')
  assert.equal(codex.HOOKS.Interrupt.capability, CAPABILITY.ADAPTED)
  assert.equal(codex.HOOKS.PermissionRequest.point, 'approval/request')
})

test('Codex rules are CARRY and explicitly not enforced', () => {
  assert.equal(codex.RULES.capability, CAPABILITY.CARRY)
  assert.ok(codex.RULES.formats.includes('starlark'))
  assert.match(codex.RULES.note, /not enforced|NOT enforced|does NOT translate/iu)
})

test('WorkBuddy: desktop hooks have no public API, and the CC-compatible subset is degraded', () => {
  assert.equal(workbuddy.BRIDGE_PACKAGE, '@deepseek-ai/dsh-hooks-claude-code')
  // The desktop app has no public hook API; every bridged entry must say that.
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    const mapping = workbuddy.HOOKS[event]
    assert.equal(mapping.capability, CAPABILITY.ADAPTED, `workbuddy ${event} should be ADAPTED`)
    assert.ok(
      mapping.degradations.some((line) => /no public hook API/iu.test(line)),
      `workbuddy ${event} must state the desktop app has no public hook API`,
    )
    assert.ok(
      mapping.degradations.some((line) => /CODEBUDDY_PROJECT_DIR/u.test(line)),
      `workbuddy ${event} must state the env-var divergence`,
    )
    assert.ok(
      mapping.degradations.some((line) => /modifiedInput/u.test(line)),
      `workbuddy ${event} must state the modifiedInput divergence`,
    )
  }
  // SessionEnd/PreCompact are documented by CodeBuddy but NOT bridged; they are
  // now translated by this adapter onto the native seams instead.
  assert.equal(workbuddy.HOOKS.SessionEnd.capability, CAPABILITY.ADAPTED)
  assert.equal(workbuddy.HOOKS.SessionEnd.route, 'native-translate')
  assert.equal(workbuddy.HOOKS.PreCompact.capability, CAPABILITY.ADAPTED)
  assert.equal(workbuddy.HOOKS.PreCompact.route, 'native-translate')
})

test('OpenCode: every callback name maps to a DSH seam, and the body is NOT carried', () => {
  assert.equal(opencode.BRIDGE_PACKAGE, null)
  // Three flavours, each with its own honest wording:
  //  - callback hooks (`tool.execute.*`, `event`, `shell.env`) carry a TS body
  //  - `permission` is a policy TABLE, re-authored as a script
  //  - event-bus names (`session.*`, `file.*`, `tui.*`, …) are observations
  const policyEvents = new Set(['permission'])  // the bare policy TABLE, not permission.* events
  let callbackLike = 0
  let busLike = 0
  for (const event of opencode.KNOWN_EVENTS) {
    const mapping = opencode.HOOKS[event]
    assert.equal(mapping.capability, CAPABILITY.ADAPTED, `${event} should be executable`)
    assert.ok(mapping.degradations.length > 0, `${event} must state its losses`)
    assert.ok(mapping.seams.length > 0, `${event} must name a DSH seam`)
    if (policyEvents.has(event)) {
      assert.ok(
        mapping.degradations.some((line) => /policy table|must be expressed as a script/iu.test(line)),
        'permission must state that its policy table is re-authored as a command',
      )
      continue
    }
    if (/^(session|file|command|installation|lsp|message|server|tui|permission)\./u.test(event)) {
      busLike += 1
      // `permission.asked` is the one bus event with a real decision channel.
      if (event === 'permission.asked') {
        assert.equal(mapping.seams[0], 'approval/request')
        assert.ok(
          mapping.degradations.some((line) => /REAL interception|allowed-once/iu.test(line)),
          'permission.asked must declare that it really decides',
        )
        continue
      }
      // Rule: a bus event must EITHER be honest that it is a coarse mapping
      // (says approximate / loses information) OR name the precise seam it rides.
      // Every row must do one of the two — an unqualified claim is the failure.
      const admitsCoarseness = mapping.degradations.some((line) =>
        /approximate|observe-only|no .*seam|no .*contract|no .*event|does not|cannot|cannot narrow|rather than|not observed|not carried/iu.test(line),
      )
      assert.ok(
        admitsCoarseness,
        `${event} must state either its approximation or its precise seam (degradations: ${mapping.degradations.join(' | ')})`,
      )
      continue
    }
    callbackLike += 1
    assert.ok(
      mapping.degradations.some((line) => /callback body is not carried|re-authored|THROWING/iu.test(line)),
      `${event} must state that the TypeScript callback body is not carried`,
    )
  }
  assert.ok(callbackLike >= 3, 'the callback-shaped hooks must still be declared')
  assert.ok(busLike >= 20, 'the event-bus names must be covered too')
  assert.match(opencode.HOOKS['tool.execute.before'].degradations.join(' '), /THROWING|re-authored/iu)
  assert.match(opencode.RUNTIME_NOTE, /rewritten|out of scope/iu)
  assert.equal(opencode.RULES.capability, CAPABILITY.CARRY)
})

test('every vendor states where its rules come from and what carrying means', () => {
  for (const vendor of VENDORS) {
    const rules = MODULES[vendor].RULES
    assert.ok(rules.defaultSources.length > 0, `${vendor} rules need default sources`)
    assert.ok(rules.formats.length > 0, `${vendor} rules need formats`)
    assert.match(rules.note, /session start|injected/iu, `${vendor} rules note must state the injection point`)
  }
})
