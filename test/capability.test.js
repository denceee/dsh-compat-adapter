/**
 * Capability vocabulary and fail-closed invariants.
 *
 * These tests encode the task's hard requirement: no capability may be claimed
 * without stating its losses, and an UNSUPPORTED asset must always carry a
 * reason. They run without a Harness because `capability.js` is pure.
 *
 * @module dsh-compat-adapter/test/capability.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CAPABILITY, CAPABILITY_ORDER, capabilityResult, isCarried, isExecutable } from '../src/capability.js'

test('four grades exist in faithfulness order', () => {
  assert.deepEqual([...CAPABILITY_ORDER], ['DIRECT', 'ADAPTED', 'CARRY', 'UNSUPPORTED'])
  assert.equal(CAPABILITY.DIRECT, 'DIRECT')
  assert.equal(CAPABILITY.ADAPTED, 'ADAPTED')
  assert.equal(CAPABILITY.CARRY, 'CARRY')
  assert.equal(CAPABILITY.UNSUPPORTED, 'UNSUPPORTED')
})

test('only DIRECT and ADAPTED are executable; only CARRY is carried', () => {
  assert.equal(isExecutable(CAPABILITY.DIRECT), true)
  assert.equal(isExecutable(CAPABILITY.ADAPTED), true)
  assert.equal(isExecutable(CAPABILITY.CARRY), false)
  assert.equal(isExecutable(CAPABILITY.UNSUPPORTED), false)
  assert.equal(isCarried(CAPABILITY.CARRY), true)
  assert.equal(isCarried(CAPABILITY.ADAPTED), false)
})

test('an UNSUPPORTED result without a reason throws', () => {
  assert.throws(
    () => capabilityResult({ id: 'x', vendor: 'claude', asset: 'hook', capability: CAPABILITY.UNSUPPORTED }),
    /must carry a reason/u,
  )
})

test('an ADAPTED result without degradations throws', () => {
  assert.throws(
    () => capabilityResult({ id: 'x', vendor: 'claude', asset: 'hook', capability: CAPABILITY.ADAPTED, degradations: [] }),
    /must list at least one degradation/u,
  )
})

test('an unknown grade throws instead of being treated as supported', () => {
  assert.throws(
    () => capabilityResult({ id: 'x', vendor: 'claude', asset: 'hook', capability: 'PARTIAL' }),
    /unknown capability/u,
  )
})

test('results are frozen, including their nested lists', () => {
  const result = capabilityResult({
    id: 'x',
    vendor: 'claude',
    asset: 'hook',
    capability: CAPABILITY.ADAPTED,
    seams: ['tools/pre-execute'],
    degradations: ['updatedInput ignored'],
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.seams), true)
  assert.equal(Object.isFrozen(result.degradations), true)
  assert.equal(result.seams[0], 'tools/pre-execute')
})
