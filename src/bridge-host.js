/**
 * Official-bridge host.
 *
 * The adapter does NOT re-implement Claude Code / Codex hook execution. For
 * every event graded `official-bridge` it delegates to the shipped DSH bridge
 * package, which owns payload construction, matcher execution, decision
 * mapping, and durable `hook/*` audit events. This module:
 *
 * 1. builds the bridge-shaped config (the same `hooks` event map both bridges
 *    parse) from the adapter's registered declarations,
 * 2. mounts one bridge plugin fiber per vendor inside the adapter's own
 *    plugin context (so its listeners unregister when the adapter unloads),
 * 3. writes the generated config into the Harness home — never into
 *    `node_modules` and never beside the bundle patch — with a name UNIQUE to
 *    this adapter instance, and
 * 4. refreshes the mounted bridge when registrations change.
 *
 * Why a generated config file instead of calling the bridge's parser: both
 * bridges read ONE `configPath` at activation and expose only `apply`/Config.
 * Reusing `apply` keeps the wire protocol, payloads, timeouts and decision
 * mapping official; writing the config is the adapter's own translation step
 * (declaration → bridge config), which is exactly the seam the task assigns to
 * this plugin.
 *
 * Why the config name is unique per instance: the file is process-global state,
 * so a fixed name would let two adapter instances (two profiles sharing one
 * Harness home, two embedded Harnesses, or two tests running concurrently)
 * overwrite each other's hook set — a silent cross-talk bug where a hook from
 * one preset fires in another. The name carries the pid and a per-process
 * counter, and `dispose()` removes the files it created.
 *
 * @module dsh-compat-adapter/bridge-host
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CompatAdapterError, ERROR_CODES } from './errors.js'

/**
 * Bridge key → how to reach it plus the config filename stem.
 *
 * `kind` matters: an `official` bridge is a shipped DSH package this adapter
 * REUSES, while a `builtin` bridge is one THIS PLUGIN ships to fill a gap DSH
 * left open (GitHub Copilot). The distinction is recorded so the matrix and the
 * README never imply a builtin bridge is an official one.
 */
const BRIDGES = Object.freeze({
  claude: Object.freeze({
    key: 'claude',
    kind: 'official',
    packageName: '@deepseek-ai/dsh-hooks-claude-code',
    configStem: 'hooks-claude-code',
  }),
  codex: Object.freeze({
    key: 'codex',
    kind: 'official',
    packageName: '@deepseek-ai/dsh-hooks-codex',
    configStem: 'hooks-codex',
  }),
  copilot: Object.freeze({
    key: 'copilot',
    kind: 'builtin',
    // Resolved relative to this module: the bridge ships with the plugin, so it
    // is always present when the adapter is (unlike an optional official bridge).
    modulePath: new URL('./bridges/copilot.js', import.meta.url).href,
    configStem: 'hooks-copilot',
  }),
})

/** Per-process instance counter, so two adapters never share a config path. */
let instanceCounter = 0

/**
 * Generated configs older than this are orphans from a process that died without
 * disposing. Long enough that a live mount can never be racing the pruner.
 */
const STALE_CONFIG_MS = 24 * 60 * 60 * 1000

/** The bridge descriptors, for README/tests. */
export function bridgeDescriptors() {
  return Object.freeze(Object.values(BRIDGES).map((bridge) => Object.freeze({ ...bridge })))
}

/**
 * Render the bridge-shaped hook config for one vendor from registered hooks.
 *
 * The bridge format is the reference 3-level shape both tools share:
 * `{ hooks: { <Event>: [ { matcher?, hooks: [ { type: 'command', command, timeout? } ] } ] } }`.
 * `statusMessage`/`if`/`once`/`async` are intentionally absent: neither shipped
 * bridge honors them, and emitting them would imply support.
 *
 * @param {Array<{event: string, matcher?: string, handler: string, timeoutSec?: number}>} hooks - declarations.
 * @returns {{hooks: Record<string, Array<object>>}} the bridge config object.
 */
export function renderBridgeConfig(hooks) {
  /** @type {Record<string, Array<object>>} */
  const events = {}
  for (const hook of hooks) {
    const groups = (events[hook.event] ??= [])
    groups.push({
      ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
      hooks: [
        {
          type: 'command',
          command: hook.handler,
          ...(hook.timeoutSec === undefined ? {} : { timeout: hook.timeoutSec }),
        },
      ],
    })
  }
  return { hooks: events }
}

/**
 * Render Copilot's OWN config format.
 *
 * Copilot differs from the Claude/Codex shape in three ways this renderer must
 * respect, because the builtin bridge parses Copilot's documented format rather
 * than a synthesized subset:
 *
 * - a top-level `version: 1` envelope;
 * - events in lowerCamelCase as Copilot declares them;
 * - command entries are FLAT (`{type, command, matcher, timeoutSec}`), not
 *   wrapped in a `hooks` array.
 *
 * @param {Array<{event: string, matcher?: string, handler: string, timeoutSec?: number}>} hooks - declarations.
 * @returns {{version: number, hooks: Record<string, Array<object>>}} the Copilot config object.
 */
export function renderCopilotConfig(hooks) {
  /** @type {Record<string, Array<object>>} */
  const events = {}
  for (const hook of hooks) {
    const entries = (events[hook.event] ??= [])
    entries.push({
      type: 'command',
      // `command` is Copilot's cross-platform fallback, honored on every platform.
      command: hook.handler,
      ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
      ...(hook.timeoutSec === undefined ? {} : { timeoutSec: hook.timeoutSec }),
    })
  }
  return { version: 1, hooks: events }
}

/**
 * Own the generated config files and the mounted bridge fibers. One instance per
 * adapter service; all state is released by {@link dispose}.
 */
export class BridgeHost {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - the adapter's plugin context.
   * @param {object} options - host options.
   * @param {string} options.dataDir - writable directory for generated bridge configs.
   * @param {(line: string) => void} [options.log] - diagnostics sink.
   */
  constructor(ctx, options) {
    this.ctx = ctx
    this.dataDir = options.dataDir
    this.log = options.log ?? (() => {})
    instanceCounter += 1
    /** Unique suffix for this instance's generated files (`<pid>-<n>`). */
    this.instanceId = `${process.pid}-${instanceCounter}`
    /**
     * Per-sync sequence for generated config names. Every write must produce a
     * NEW path: a remount writes the replacement config before unmounting the
     * old fiber, and unmounting deletes the old fiber's config. Reusing one name
     * would delete the config the new bridge is about to read.
     */
    this.syncSeq = 0
    /** @type {Map<string, {fiber: object|undefined, hooks: object[], configPath: string}>} */
    this.mounted = new Map()
    /** @type {Set<string>} config files this instance created. */
    this.generatedFiles = new Set()
    this.disposed = false
    this.#pruneStaleConfigs()
  }

  /**
   * Ensure one vendor's official bridge is mounted with exactly `hooks`.
   * Mounting is idempotent: an unchanged declaration set reuses the fiber; a
   * changed set re-mounts it so the bridge re-parses its config.
   *
   * @param {'claude'|'codex'} bridgeKey - which official bridge.
   * @param {Array<object>} hooks - the vendor's bridged hook declarations.
   * @returns {Promise<{mounted: boolean, configPath: string}>} mount facts.
   * @throws {CompatAdapterError} BRIDGE_UNAVAILABLE when the DSH bridge package is absent.
   */
  async sync(bridgeKey, hooks) {
    if (this.disposed) {
      throw new CompatAdapterError(ERROR_CODES.ADAPTER_DISPOSED, 'dsh-compat-adapter: the adapter was disposed; no further registrations are accepted')
    }
    const descriptor = BRIDGES[bridgeKey]
    if (descriptor === undefined) {
      throw new CompatAdapterError(ERROR_CODES.INVALID_DECLARATION, `dsh-compat-adapter: unknown official bridge ${JSON.stringify(bridgeKey)}`, {
        bridges: Object.keys(BRIDGES),
      })
    }
    const current = this.mounted.get(bridgeKey)
    const signature = JSON.stringify(hooks)
    if (current !== undefined && JSON.stringify(current.hooks) === signature) {
      return { mounted: true, configPath: current.configPath }
    }
    if (hooks.length === 0) {
      if (current !== undefined) await this.#unmount(bridgeKey)
      return { mounted: false, configPath: '' }
    }

    // TRANSACTIONAL remount: prepare everything that can fail (write the new
    // config, resolve the bridge package) BEFORE touching the live bridge. If
    // any preparation step throws, the previously mounted bridge stays mounted
    // and keeps running — a failed registration must never silently unload the
    // hooks that were already working.
    let configPath
    try {
      configPath = this.#writeConfig(descriptor, hooks)
    } catch (error) {
      throw new CompatAdapterError(
        ERROR_CODES.MOUNT_FAILED,
        `dsh-compat-adapter: cannot write the generated ${descriptor.key} bridge config under ${this.dataDir} (${String(error?.message ?? error)}). ` +
          'The previously mounted hooks are untouched. Fix the Harness home permissions (or set DSH_HOME to a writable directory) and retry.',
        { dataDir: this.dataDir },
      )
    }
    let bridgeModule
    try {
      bridgeModule = await this.#loadBridge(descriptor)
    } catch (error) {
      this.#discard(configPath)
      throw error
    }

    // Preparation succeeded: now swap. The new config has a FRESH path, so the
    // old fiber's config can be deleted safely before the new fiber mounts.
    if (current !== undefined) await this.#unmount(bridgeKey)
    let fiber
    try {
      fiber = await this.ctx.plugin(bridgeModule, { configPath })
    } catch (error) {
      this.#discard(configPath)
      // The old bridge is already unmounted, so roll the previous hook set back
      // in. A failed registration must not cost the preset the hooks it already
      // had; if even the rollback fails, say so instead of pretending.
      const restored = await this.#restore(descriptor, bridgeModule, current)
      throw new CompatAdapterError(
        ERROR_CODES.MOUNT_FAILED,
        `dsh-compat-adapter: the official bridge ${descriptor.packageName} failed to mount (${String(error?.message ?? error)}). The hook was not registered.` +
          (current === undefined ? '' : restored ? ' The previously mounted hooks were restored.' : ' WARNING: the previously mounted hooks could NOT be restored.'),
        { packageName: descriptor.packageName, restored },
      )
    }
    this.mounted.set(bridgeKey, { fiber, hooks: [...hooks], configPath })
    this.log(`bridge ${descriptor.packageName} mounted with ${hooks.length} hook group(s) from ${configPath}`)
    return { mounted: true, configPath }
  }

  /**
   * Dispose every mounted bridge and delete the generated configs. The fibers
   * are also children of the adapter plugin, so disposal is idempotent and
   * ordering-safe.
   *
   * @returns {Promise<void>} settles when every bridge fiber is unloaded.
   */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    const keys = [...this.mounted.keys()]
    for (const key of keys) {
      try {
        await this.#unmount(key)
      } catch (error) {
        this.log(`bridge disposal failed: ${String(error)}`)
      }
    }
    for (const file of this.generatedFiles) {
      try {
        rmSync(file, { force: true })
      } catch (error) {
        this.log(`generated config cleanup failed for ${file}: ${String(error)}`)
      }
    }
    this.generatedFiles.clear()
  }

  /**
   * Best-effort rollback: re-render the previous hook set and mount it again.
   *
   * @param {object} descriptor - bridge descriptor.
   * @param {object} bridgeModule - already-imported bridge namespace.
   * @param {{hooks: object[], configPath: string}|undefined} previous - the entry that was live before the failed swap.
   * @returns {Promise<boolean>} whether the previous hook set is live again.
   */
  async #restore(descriptor, bridgeModule, previous) {
    if (previous === undefined) return false
    let configPath
    try {
      configPath = this.#writeConfig(descriptor, previous.hooks)
    } catch {
      return false
    }
    try {
      const fiber = await this.ctx.plugin(bridgeModule, { configPath })
      this.mounted.set(descriptor.key, { fiber, hooks: [...previous.hooks], configPath })
      this.log(`rolled the ${descriptor.key} bridge back to its previous ${previous.hooks.length} hook group(s) after a failed remount`)
      return true
    } catch {
      this.#discard(configPath)
      return false
    }
  }

  /**
   * Remove generated configs left behind by processes that died without
   * disposing (killed runs, crashes). Files are only ever read at mount time and
   * every mount writes a fresh path, so an orphan cannot be picked up; pruning
   * just keeps the Harness home from growing without bound. The age bound makes
   * it impossible to race a live mount.
   *
   * @returns {number} how many files were removed.
   */
  #pruneStaleConfigs() {
    const dir = join(this.dataDir, 'compat-adapter')
    if (!existsSync(dir)) return 0
    const cutoff = Date.now() - STALE_CONFIG_MS
    let removed = 0
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const full = join(dir, entry.name)
      try {
        if (statSync(full).mtimeMs >= cutoff) continue
        rmSync(full, { force: true })
        removed += 1
      } catch {
        /* another process may be pruning too; best effort */
      }
    }
    if (removed > 0) this.log(`pruned ${removed} stale generated bridge config(s) from ${dir}`)
    return removed
  }

  /**
   * Delete a generated config that never became live.
   *
   * @param {string} configPath - config path to remove.
   * @returns {void}
   */
  #discard(configPath) {
    if (configPath === '') return
    try {
      rmSync(configPath, { force: true })
    } catch {
      /* best effort: an orphaned generated file is never re-read */
    }
    this.generatedFiles.delete(configPath)
  }

  /**
   * Unmount one bridge and drop its generated config.
   *
   * @param {string} bridgeKey - bridge to unmount.
   * @returns {Promise<void>} settles when the fiber is disposed.
   */
  async #unmount(bridgeKey) {
    const entry = this.mounted.get(bridgeKey)
    if (entry === undefined) return
    this.mounted.delete(bridgeKey)
    try {
      await entry.fiber?.dispose()
    } finally {
      this.#discard(entry.configPath)
    }
  }

  /**
   * Write the generated config into the profile data dir. Never inside
   * `node_modules`, never beside the bundle patch: an installed bundle's
   * directory is package-managed and a stale file there would be overwritten by
   * the next install.
   *
   * @param {object} descriptor - bridge descriptor.
   * @param {Array<object>} hooks - declarations.
   * @returns {string} absolute config path.
   */
  #writeConfig(descriptor, hooks) {
    const dir = join(this.dataDir, 'compat-adapter')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.syncSeq += 1
    const configPath = join(dir, `${descriptor.configStem}.${this.instanceId}.${this.syncSeq}.json`)
    // A builtin bridge parses ITS vendor's documented format; official bridges
    // share the Claude/Codex matcher-group shape.
    const document = descriptor.kind === 'builtin' ? renderCopilotConfig(hooks) : renderBridgeConfig(hooks)
    writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    this.generatedFiles.add(configPath)
    return configPath
  }

  /**
   * Dynamically import an installed official bridge by package name. A missing
   * bridge is a loud, typed failure: the adapter must not pretend the event
   * still works.
   *
   * @param {object} descriptor - bridge descriptor.
   * @returns {Promise<object>} the bridge module namespace.
   */
  async #loadBridge(descriptor) {
    // A builtin bridge ships with this plugin, so it resolves relative to this
    // module and cannot be missing. An official bridge is a DSH package that may
    // legitimately be absent, which is a loud typed failure.
    const target = descriptor.kind === 'builtin' ? descriptor.modulePath : descriptor.packageName
    try {
      return await import(target)
    } catch (error) {
      if (descriptor.kind === 'builtin') {
        throw new CompatAdapterError(
          ERROR_CODES.MOUNT_FAILED,
          `dsh-compat-adapter: the plugin's own ${descriptor.key} bridge failed to load (${String(error?.message ?? error)}). ` +
            'This is an installation defect, not a missing dependency: reinstall the bundle.',
          { modulePath: target },
        )
      }
      throw new CompatAdapterError(
        ERROR_CODES.BRIDGE_UNAVAILABLE,
        `dsh-compat-adapter: the official bridge ${descriptor.packageName} is not resolvable from this profile (${String(error?.message ?? error)}). ` +
          `Vendor hooks cannot be adapted without it. Install the shipped DSH bridge or remove the ${descriptor.key} hook declarations.`,
        { packageName: descriptor.packageName },
      )
    }
  }
}
