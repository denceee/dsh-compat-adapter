/**
 * dsh-compat-adapter — a front/base adapter plugin for DeepSeek Harness.
 *
 * It provides one Cordis service, `ctx.compatAdapter`, that preset-class
 * plugins call while they are being authored to declare other agents' assets:
 *
 *   ctx.compatAdapter.registerHook({ vendor, event, matcher, handler })
 *   ctx.compatAdapter.registerRules({ vendor, source })
 *
 * Every registration returns a graded capability result (DIRECT / ADAPTED /
 * CARRY / UNSUPPORTED); nothing is guessed from file detection: the preset
 * author declares the vendor explicitly and the adapter routes that declaration
 * to a DSH seam or refuses it with a reason.
 *
 * Hooks reuse the official bridges (`dsh-hooks-claude-code`, `dsh-hooks-codex`)
 * rather than re-implementing their wire protocol; see src/bridge-host.js.
 * Events with no bridge and no faithful seam are rejected (fail-closed) or, for
 * observation-only lifecycle moments, routed to native Host events with an
 * explicit ADAPTED degradation list.
 *
 * @module dsh-compat-adapter
 */

import { CompatAdapter } from './src/service.js'
import { loadPeer } from './src/peer.js'
import { DSH_SURFACE, versionMismatchMessage } from './src/surface.js'

export const name = 'compat-adapter'

/**
 * Services this plugin consumes. Intentionally empty: the adapter provides its
 * service in ANY composition and grades individual hooks against the surface
 * that actually exists (a hook needs `ctx.shell`; rules do not). Declaring
 * `inject: ['shell']` here would keep the service from mounting in a
 * rules-only composition, which is a supported use case.
 */
export const inject = []

/**
 * Config defaults, used when the schema library cannot be loaded.
 *
 * @returns {object} the conservative defaults.
 */
function configDefaults() {
  return {
    targetDshVersion: DSH_SURFACE.dshVersion,
    logRegistrations: true,
    failClosed: true,
    maxRuleBytes: 512 * 1024,
  }
}

/**
 * Plugin config schema.
 *
 * `@deepseek-ai/schemastery` is a peer of a bundle installed into a profile, so
 * it is imported lazily: when it resolves (the normal case) the Loader gets a
 * real schema and the profile UI can render the config form; when it does not,
 * the plugin still mounts with a validating fallback instead of vanishing from
 * the composition. The fallback is a function with the same call shape as a
 * schemastery schema, so `apply` is unchanged either way.
 */
export const Config = await (async () => {
  try {
    const z = await loadPeer('@deepseek-ai/schemastery')
    const { default: schema } = z
    return schema.object({
      /** DSH version this plugin was authored against; a mismatch is reported loudly at activation. */
      targetDshVersion: schema.string().default(DSH_SURFACE.dshVersion),
      /** Emit one structured log line per graded registration (useful when authoring presets). */
      logRegistrations: schema.boolean().default(true),
      /** Refuse hook registrations whose required surface is missing instead of mounting a no-op. */
      failClosed: schema.boolean().default(true),
      /** Per-file cap for carried rules text, in bytes. */
      maxRuleBytes: schema.number().default(512 * 1024),
    })
  } catch {
    // No schema library: validate what we can and fall back to the defaults.
    const validate = (input) => {
      const value = input ?? {}
      if (value.logRegistrations !== undefined && typeof value.logRegistrations !== 'boolean') {
        throw new TypeError('dsh-compat-adapter: logRegistrations must be a boolean')
      }
      if (value.failClosed !== undefined && typeof value.failClosed !== 'boolean') {
        throw new TypeError('dsh-compat-adapter: failClosed must be a boolean')
      }
      if (value.maxRuleBytes !== undefined && typeof value.maxRuleBytes !== 'number') {
        throw new TypeError('dsh-compat-adapter: maxRuleBytes must be a number')
      }
      if (value.targetDshVersion !== undefined && typeof value.targetDshVersion !== 'string') {
        throw new TypeError('dsh-compat-adapter: targetDshVersion must be a string')
      }
      return { ...configDefaults(), ...value }
    }
    return validate
  }
})()

/**
 * Mount the adapter service.
 *
 * Cleanup is registered with `ctx.effect(...)` rather than returned from
 * `apply`: Cordis's `isConstructor()` check treats a `function`-declared plugin
 * as a class and instantiates it, which SILENTLY DISCARDS a returned disposer —
 * the bridges would then keep listening after the plugin unloaded. An effect is
 * the idiomatic, awaited cleanup path and is also what every shipped DSH plugin
 * uses.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
 * @param {z.infer<typeof Config>} [config] - validated plugin config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = {
    logRegistrations: config?.logRegistrations ?? true,
    failClosed: config?.failClosed ?? true,
    targetDshVersion: config?.targetDshVersion ?? DSH_SURFACE.dshVersion,
    maxRuleBytes: config?.maxRuleBytes ?? 512 * 1024,
  }
  const runtimeVersion = readRuntimeDshVersion()
  if (runtimeVersion !== undefined && runtimeVersion !== resolved.targetDshVersion) {
    const message = versionMismatchMessage(runtimeVersion, resolved.targetDshVersion)
    if (resolved.failClosed) throw new Error(message)
    ctx.logger?.warn?.(message)
  }
  const adapter = new CompatAdapter(ctx, resolved)
  const serviceDisposer = ctx.provide('compatAdapter', adapter)
  // Reverse registration order on unload: this effect's disposer runs BEFORE the
  // service-provide disposer, so the adapter is fully unwound before the service
  // disappears from the context.
  ctx.effect(
    () => async () => {
      await adapter.dispose()
      serviceDisposer()
    },
    'compat-adapter.dispose',
  )
}

/**
 * Read an explicitly declared runtime DSH version, when the launcher supplies
 * one. A bundle is not guaranteed to resolve `@deepseek-ai/dsh`, so the adapter
 * does not probe the installation; exactness comes from `check-surface` and the
 * `dshVersion` pin in `src/surface.js`.
 *
 * @returns {string|undefined} the declared version, if any.
 */
function readRuntimeDshVersion() {
  const override = process.env.DSH_COMPAT_ADAPTER_DSH_VERSION
  return typeof override === 'string' && override !== '' ? override : undefined
}
