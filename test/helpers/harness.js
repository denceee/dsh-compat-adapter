/**
 * Minimal real-Harness fixture for tests.
 *
 * The adapter's contract is about DSH seams, so a mock would test the mock.
 * This helper boots a genuine Cordis `Context`, mounts the shipped shell
 * executor pair (`dsh-subprocess-local` → `dsh-bash-local`) so `ctx.shell`
 * exists exactly as in a profile, and mounts a stub `sessionProjections` service
 * (the bridges declare it in `inject`, and this project only needs the service
 * to exist, not to project anything).
 *
 * @module dsh-compat-adapter/test/helpers/harness
 */

import { Context } from '@deepseek-ai/cordis'
import * as SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import * as BashLocal from '@deepseek-ai/dsh-bash-local'

/**
 * Build a real Harness context with a working `ctx.shell`.
 *
 * @param {object} [options] - fixture options.
 * @param {boolean} [options.withShell] - mount the shell pair (default true).
 * @param {object} [options.config] - shell executor config.
 * @returns {Promise<{ctx: Context, dispose: () => Promise<void>}>} the fixture.
 */
export async function createHarness(options = {}) {
  const withShell = options.withShell ?? true
  const ctx = new Context()
  const disposers = []

  // The bridges `inject: ['shell', 'sessionProjections']`; the projection
  // service itself is irrelevant here, only its presence is contractual.
  disposers.push(
    ctx.provide('sessionProjections', {
      /** @returns {undefined} stub: this fixture projects nothing. */
      get() {
        return undefined
      },
    }),
  )

  if (withShell) {
    await ctx.plugin(SubprocessLocal.default, {})
    await ctx.plugin(BashLocal.default, options.config ?? { timeoutMs: 30_000 })
  }

  return {
    ctx,
    /** @returns {Promise<void>} disposes the whole fiber tree. */
    async dispose() {
      await ctx.fiber?.dispose?.()
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* already unwound */
        }
      }
    },
  }
}

/**
 * Mount the adapter service directly (bypassing the plugin wrapper's config
 * schema) so a unit test can drive `registerHook` / `registerRules` and inspect
 * the live surfaces.
 *
 * @param {object} options - fixture options.
 * @param {object} [options.config] - adapter config overrides.
 * @param {boolean} [options.withShell] - mount the shell pair.
 * @returns {Promise<{ctx: object, adapter: object, dispose: () => Promise<void>}>} the fixture.
 */
export async function createAdapterFixture(options = {}) {
  const { CompatAdapter } = await import('../../src/service.js')
  const harness = await createHarness({ withShell: options.withShell })
  const adapter = new CompatAdapter(harness.ctx, {
    logRegistrations: options.logRegistrations ?? false,
    failClosed: options.failClosed ?? true,
    targetDshVersion: '0.2.0-rc.2',
    maxRuleBytes: options.maxRuleBytes ?? 512 * 1024,
  })
  return {
    ctx: harness.ctx,
    adapter,
    /** @returns {Promise<void>} disposes the adapter then the harness. */
    async dispose() {
      await adapter.dispose()
      await harness.dispose()
    },
  }
}
