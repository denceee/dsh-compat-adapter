/**
 * `ctx.compatAdapter` — the adapter service.
 *
 * Preset-class plugins declare other agents' assets here and get a graded
 * capability answer back. The service is the single place that:
 *
 * 1. resolves the declared vendor (explicit declaration only; never guessed),
 * 2. grades the asset against that vendor's frozen capability table,
 * 3. routes what is portable:
 *    - `official-bridge` hooks → the shipped DSH bridge for that dialect,
 *    - `native-seam` hooks → a native observation router (observe-only),
 *    - `CARRY` rules → verbatim text injection at agent start,
 * 4. returns a frozen capability result for every call, including refusals.
 *
 * There is no "best effort" path: an UNSUPPORTED asset is never mounted. The
 * service is also the audit surface — `status()` reports exactly what is live.
 *
 * @module dsh-compat-adapter/service
 */

import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPeer, loadPeerExport } from './peer.js'
import { CAPABILITY, capabilityResult } from './capability.js'
import { CompatAdapterError, ERROR_CODES } from './errors.js'
import { BridgeHost } from './bridge-host.js'
import { buildObservePayload, runObservedHook, OBSERVE_POINTS } from './observe.js'
import {
  NATIVE_TRANSLATIONS,
  buildTranslationPayload,
  injectedContextFrom,
  permissionVerdictFrom,
  postToolDecisionFrom,
  preToolDecisionFrom,
  runTranslatedHook,
  stopDecisionFrom,
  transformedPromptFrom,
} from './translate.js'
import {
  readRuleAsset,
  renderRulesContext,
  resolveBaseDir,
  resolveRuleFiles,
  rulesCapability,
  rulesSource,
} from './rules.js'
import { DSH_SURFACE } from './surface.js'
import { vendorModule, vendorNames, VENDORS } from './vendors/index.js'
import { buildMatrix } from './matrix.js'

/**
 * Reference default hook timeout (10 minutes), shared by both bridges. Mirrored
 * here so the adapter's own observe-only runs use the same default without a
 * load-time dependency on the protocol package.
 */
const FALLBACK_HOOK_TIMEOUT_MS = 600_000

/**
 * Consecutive stop-blocks allowed before the adapter stops forcing turns.
 * Mirrors Copilot's own runaway guard (8), so a buggy unconditional hook cannot
 * spin the agent forever.
 */
const STOP_BLOCK_LIMIT = 8

/** Handler types the reference tools define; only `command` can be adapted. */
const HANDLER_TYPES = Object.freeze(['command', 'http', 'mcp_tool', 'prompt', 'agent'])

/**
 * Normalize the `handler` field of a hook declaration. Only command hooks have
 * a DSH execution path (through the official bridges); every other handler
 * family is refused with a reason instead of being silently dropped.
 *
 * @param {unknown} handler - declared handler (string command or `{type, command}`).
 * @returns {{kind: 'command', command: string, timeoutSec?: number}} the command hook.
 * @throws {CompatAdapterError} INVALID_HANDLER when the shape is unsupported.
 */
function normalizeHandler(handler) {
  if (typeof handler === 'string' && handler.trim() !== '') {
    return { kind: 'command', command: handler }
  }
  if (handler !== null && typeof handler === 'object') {
    const type = handler.type
    if (type !== undefined && !HANDLER_TYPES.includes(type)) {
      throw new CompatAdapterError(
        ERROR_CODES.INVALID_HANDLER,
        `dsh-compat-adapter: unknown hook handler type ${JSON.stringify(type)}; accepted types are ${HANDLER_TYPES.join(', ')}.`,
        { acceptedTypes: HANDLER_TYPES },
      )
    }
    if (type === undefined || type === 'command') {
      if (typeof handler.command !== 'string' || handler.command.trim() === '') {
        throw new CompatAdapterError(ERROR_CODES.INVALID_HANDLER, 'dsh-compat-adapter: a command hook needs a non-empty `command` string.')
      }
      return {
        kind: 'command',
        command: handler.command,
        ...(handler.timeoutSec === undefined ? {} : { timeoutSec: handler.timeoutSec }),
      }
    }
    throw new CompatAdapterError(
      ERROR_CODES.INVALID_HANDLER,
      `dsh-compat-adapter: hook handler type ${JSON.stringify(type)} cannot be adapted. Only command hooks run through the official bridges; http, mcp_tool, prompt and agent handlers have no DSH equivalent (the shipped bridges parse and skip them).`,
      { handlerType: type },
    )
  }
  throw new CompatAdapterError(
    ERROR_CODES.INVALID_HANDLER,
    'dsh-compat-adapter: hook `handler` must be a shell command string or a `{ type: "command", command }` object.',
  )
}

/**
 * Validate a matcher and return the string the official bridge should receive.
 *
 * Matcher SEMANTICS stay with the owning bridge: this adapter deliberately does
 * not re-implement Claude's literal-or-regex rule or Codex's always-regex rule,
 * because a re-implementation would drift from the bridge that actually runs the
 * hook. What the adapter does enforce is the type: a matcher is a policy
 * selector, so dropping an uninterpretable one would broaden what the hook sees.
 * An absent matcher stays absent (match-all) exactly as the vendor documents.
 *
 * @param {unknown} matcher - declared matcher.
 * @returns {string|undefined} matcher to hand to the bridge.
 */
function normalizeMatcher(matcher) {
  if (matcher === undefined || matcher === null) return undefined
  if (typeof matcher !== 'string') {
    throw new CompatAdapterError(ERROR_CODES.INVALID_MATCHER, `dsh-compat-adapter: hook matcher must be a string, got ${typeof matcher}.`)
  }
  return matcher
}

/**
 * The adapter service. Constructed once by the plugin and exposed as
 * `ctx.compatAdapter`; every listener and bridge fiber is owned by the same
 * plugin context, so unloading the plugin unloads the adaptation.
 */
export class CompatAdapter {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context that owns every listener and bridge fiber.
   * @param {object} config - resolved plugin config.
   * @param {boolean} config.logRegistrations - log one line per graded registration.
   * @param {boolean} config.failClosed - refuse registrations whose surface is missing.
   * @param {string} config.targetDshVersion - DSH version the preset targets.
   * @param {number} config.maxRuleBytes - per-file carry cap.
   */
  constructor(ctx, config) {
    /** @type {import('@deepseek-ai/cordis').Context} */
    this.ctx = ctx
    /** @type {{logRegistrations: boolean, failClosed: boolean, targetDshVersion: string, maxRuleBytes: number}} */
    this.config = config
    this.disposed = false
    /** @type {Map<string, {declaration: object, result?: object, entry?: object, bridgeKey?: string, observation?: object}>} */
    this.hooks = new Map()
    /** @type {Map<string, {declaration: object, result: object, assets: object[], vendors: string[]}>} */
    this.rules = new Map()
    /** @type {BridgeHost} */
    this.bridgeHost = new BridgeHost(ctx, {
      dataDir: this.#resolveDataDir(),
      log: (line) => this.#log(line),
    })
    this.#installRuleListener()
    this.#log(`compat-adapter ready against DSH ${DSH_SURFACE.dshVersion}; vendors: ${VENDORS.join(', ')}`)
  }

  /**
   * Declare one other-agent hook and route it to a DSH seam.
   *
   * This is the entry point a preset-class plugin calls from its own `apply()`.
   * It never throws for an UNPORTABLE asset (that comes back as a graded
   * result); it throws only when the DECLARATION itself cannot be processed.
   *
   * @example
   * export const inject = ['compatAdapter']
   * export function apply(ctx) {
   *   // fire-and-forget is fine: the result is also recorded in status()
   *   void ctx.compatAdapter.registerHook({
   *     vendor: 'copilot',
   *     event: 'preToolUse',
   *     matcher: 'bash',
   *     handler: 'node ./hooks/deny-dangerous.cjs',
   *   })
   * }
   *
   * @param {object} declaration - hook declaration.
   * @param {string} declaration.vendor - one of `claude`, `codex`, `workbuddy`,
   *   `opencode`, `copilot` (documented aliases accepted). See `matrix()` for the
   *   exact event list each vendor accepts.
   * @param {string} declaration.event - the vendor's hook event name (e.g. `PreToolUse`).
   * @param {string} [declaration.matcher] - vendor matcher pattern.
   * @param {string|{type?: string, command?: string, timeoutSec?: number}} [declaration.handler] - command hook. A JS function handler is graded UNSUPPORTED.
   * @param {string} [declaration.id] - stable id; defaults to `<vendor>:<event>:<n>`.
   * @returns {Promise<Readonly<object>>} the frozen capability result (never throws for an unportable asset).
   * @throws {CompatAdapterError} for an unknown vendor/event or a malformed declaration.
   */
  async registerHook(declaration) {
    this.#assertActive('registerHook')
    if (declaration === null || typeof declaration !== 'object') {
      throw new CompatAdapterError(ERROR_CODES.INVALID_DECLARATION, 'dsh-compat-adapter: registerHook expects a declaration object')
    }
    const module = this.#requireVendor(declaration.vendor)
    const event = declaration.event
    if (typeof event !== 'string' || event.trim() === '') {
      throw new CompatAdapterError(ERROR_CODES.INVALID_DECLARATION, 'dsh-compat-adapter: registerHook requires a non-empty `event` string')
    }
    const mapping = module.HOOKS[event]
    if (mapping === undefined) {
      throw new CompatAdapterError(
        ERROR_CODES.UNKNOWN_EVENT,
        `dsh-compat-adapter: vendor ${module.VENDOR} has no hook event named ${JSON.stringify(event)}. Known events: ${Object.keys(module.HOOKS).join(', ')}`,
        { vendor: module.VENDOR, event, knownEvents: Object.keys(module.HOOKS) },
      )
    }
    const id = declaration.id ?? `${module.VENDOR}:${event}:${this.hooks.size}`

    // Fail-closed grading happens BEFORE any side effect: an unsupported asset
    // never writes a config, never mounts a bridge, never appears live.
    if (mapping.capability === CAPABILITY.UNSUPPORTED) {
      return this.#recordHook(id, declaration, capabilityResult({
        id,
        vendor: module.VENDOR,
        asset: 'hook',
        capability: CAPABILITY.UNSUPPORTED,
        event,
        seams: [],
        reason: mapping.reason,
      }))
    }
    if (typeof declaration.handler === 'function') {
      return this.#recordHook(id, declaration, capabilityResult({
        id,
        vendor: module.VENDOR,
        asset: 'hook',
        capability: CAPABILITY.UNSUPPORTED,
        event,
        seams: [...mapping.seams],
        reason:
          "JS function handlers cannot cross the declaration boundary: this adapter carries other agents' declared assets into DSH, it does not execute foreign code inside the Host. Write a native DSH plugin and mount it on the same seam instead.",
      }))
    }

    const handler = normalizeHandler(declaration.handler)
    const matcher = normalizeMatcher(declaration.matcher)

    if (mapping.route === 'native-seam') {
      return this.#registerObservedHook(id, declaration, module, event, mapping, handler)
    }
    if (mapping.route === 'native-translate') {
      return this.#registerTranslatedHook(id, declaration, module, event, mapping, handler)
    }
    return this.#registerBridgedHook(id, declaration, module, event, mapping, handler, matcher)
  }

  /**
   * Declare other-agent rules files; they are carried verbatim and injected as
   * context at agent start. Rules never become executable policy.
   *
   * @example
   * void ctx.compatAdapter.registerRules({
   *   vendor: 'codex',
   *   source: 'rules/*.rules',
   *   baseDir: new URL('.', import.meta.url).pathname,
   * })
   *
   * @param {object} declaration - rules declaration.
   * @param {string} declaration.vendor - vendor key.
   * @param {string|string[]} declaration.source - absolute path, `baseDir`-relative path, `file://` URL, or glob.
   * @param {string} [declaration.baseDir] - absolute base directory for relative sources.
   * @param {string} [declaration.id] - stable id.
   * @returns {Promise<Readonly<object>>} the frozen CARRY capability result.
   * @throws {CompatAdapterError} for an unknown vendor or an unreadable/missing/oversized source.
   */
  async registerRules(declaration) {
    this.#assertActive('registerRules')
    if (declaration === null || typeof declaration !== 'object') {
      throw new CompatAdapterError(ERROR_CODES.INVALID_DECLARATION, 'dsh-compat-adapter: registerRules expects a declaration object')
    }
    const module = this.#requireVendor(declaration.vendor)
    const baseDir = resolveBaseDir(declaration.baseDir)
    const files = resolveRuleFiles(declaration.source, baseDir)
    const id = declaration.id ?? `${module.VENDOR}:rules:${this.rules.size}`
    const assets = files.map((file) => readRuleAsset(file, module.VENDOR, { maxBytes: this.config.maxRuleBytes }))
    const result = rulesCapability(module.VENDOR, module.RULES, assets)
    this.rules.set(id, { declaration: { ...declaration, baseDir }, result, assets, vendors: [module.VENDOR] })
    this.#logCapability(result, `${assets.length} file(s) carried from ${files.join(', ')}`)
    return result
  }

  /**
   * Report what this adapter is actually running. The audit surface: a preset
   * author can call this at runtime instead of trusting documentation.
   *
   * @returns {Readonly<object>} live registration summary.
   */
  status() {
    const hooks = [...this.hooks.values()].map((live) => ({
      id: live.result?.id ?? live.entry?.id ?? '',
      vendor: live.result?.vendor ?? '',
      event: live.result?.event ?? live.entry?.event ?? '',
      capability: live.result?.capability ?? 'MOUNTED',
      seams: [...(live.result?.seams ?? [])],
      ...(live.bridgeKey === undefined ? {} : { bridge: live.bridgeKey }),
      ...(live.observation === undefined ? {} : { observationPoint: live.observation.point }),
    }))
    const rules = [...this.rules.values()].map((entry) => ({
      id: entry.result.id,
      vendor: entry.result.vendor,
      capability: entry.result.capability,
      files: entry.assets.map((asset) => ({ path: asset.path, bytes: asset.bytes, sha256: asset.sha256 })),
    }))
    const shell = this.ctx.get('shell')
    return Object.freeze({
      dshVersion: DSH_SURFACE.dshVersion,
      targetDshVersion: this.config.targetDshVersion,
      disposed: this.disposed,
      vendors: Object.freeze([...VENDORS]),
      surface: Object.freeze({
        shell: shell !== undefined,
        sessionProjections: this.ctx.get('sessionProjections') !== undefined,
      }),
      hooks: Object.freeze(hooks.map((entry) => Object.freeze(entry))),
      rules: Object.freeze(rules.map((entry) => Object.freeze(entry))),
      counts: Object.freeze({
        hooks: hooks.length,
        executableHooks: hooks.filter((entry) => entry.capability === CAPABILITY.DIRECT || entry.capability === CAPABILITY.ADAPTED).length,
        unsupportedHooks: hooks.filter((entry) => entry.capability === CAPABILITY.UNSUPPORTED).length,
        rules: rules.length,
        carriedFiles: rules.reduce((total, entry) => total + entry.files.length, 0),
      }),
    })
  }

  /**
   * The static capability matrix (what this adapter version can ever do), as
   * opposed to {@link status} (what is live in this composition).
   *
   * @returns {readonly object[]} frozen per-vendor matrices.
   */
  matrix() {
    return buildMatrix()
  }

  /**
   * Unload every bridge and listener. Idempotent; the service refuses further
   * registrations afterwards instead of half-working.
   *
   * @returns {Promise<void>} settles when every owned fiber is disposed.
   */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    await this.bridgeHost.dispose()
    this.hooks.clear()
    this.rules.clear()
  }

  /**
   * @param {string} method - method name for the diagnostic.
   * @returns {void}
   */
  #assertActive(method) {
    if (this.disposed) {
      throw new CompatAdapterError(ERROR_CODES.ADAPTER_DISPOSED, `dsh-compat-adapter: ${method} called after the adapter was disposed; registrations must happen during plugin setup.`)
    }
  }

  /**
   * Resolve a declared vendor or fail with the accepted spellings.
   *
   * @param {unknown} vendor - declared vendor.
   * @returns {Readonly<object>} the vendor adapter module.
   */
  #requireVendor(vendor) {
    const module = vendorModule(vendor)
    if (module === undefined) {
      throw new CompatAdapterError(
        ERROR_CODES.UNKNOWN_VENDOR,
        `dsh-compat-adapter: unknown vendor ${JSON.stringify(vendor)}. Declare one of ${vendorNames().join(', ')}; vendors are never guessed from file names or imports.`,
        { acceptedVendors: vendorNames() },
      )
    }
    return module
  }

  /**
   * Route a bridge-capable hook through the shipped official bridge. The whole
   * bridge config is re-rendered from live state on every registration, because
   * a bridge reads exactly one config file at activation.
   *
   * @param {string} id - registration id.
   * @param {object} declaration - original declaration.
   * @param {Readonly<object>} module - vendor module.
   * @param {string} event - event name.
   * @param {import('./vendors/shared.js').HookMapping} mapping - capability mapping.
   * @param {{kind: 'command', command: string, timeoutSec?: number}} handler - normalized handler.
   * @param {string|undefined} matcher - normalized matcher.
   * @returns {Promise<Readonly<object>>} the capability result.
   */
  async #registerBridgedHook(id, declaration, module, event, mapping, handler, matcher) {
    if (this.ctx.get('shell') === undefined) {
      return this.#recordHook(id, declaration, capabilityResult({
        id,
        vendor: module.VENDOR,
        asset: 'hook',
        capability: CAPABILITY.UNSUPPORTED,
        event,
        seams: [...mapping.seams],
        reason:
          'This composition has no shell executor (ctx.shell), so the official hook bridge cannot run command hooks. Mount a shell plugin (dsh-bash-local or dsh-bash-sandbox) or declare this asset as rules instead.',
      }))
    }
    const bridgeKey = mapping.bridge
    const entry = {
      id,
      event,
      ...(matcher === undefined ? {} : { matcher }),
      handler: handler.command,
      ...(handler.timeoutSec === undefined ? {} : { timeoutSec: handler.timeoutSec }),
    }
    this.hooks.set(id, { declaration, bridgeKey, entry })
    const pending = []
    for (const live of this.hooks.values()) {
      if (live.bridgeKey === bridgeKey && live.entry !== undefined) pending.push(live.entry)
    }
    try {
      await this.bridgeHost.sync(bridgeKey, pending)
    } catch (error) {
      this.hooks.delete(id)
      if (error instanceof CompatAdapterError) {
        return this.#recordHook(id, declaration, capabilityResult({
          id,
          vendor: module.VENDOR,
          asset: 'hook',
          capability: CAPABILITY.UNSUPPORTED,
          event,
          seams: [...mapping.seams],
          reason: `${error.message} The hook was not mounted.`,
        }))
      }
      throw error
    }
    const result = capabilityResult({
      id,
      vendor: module.VENDOR,
      asset: 'hook',
      capability: mapping.capability,
      event,
      seams: [...mapping.seams],
      degradations: [...mapping.degradations],
      ...(mapping.note === undefined ? {} : { note: mapping.note }),
    })
    this.hooks.set(id, { declaration, result, bridgeKey, entry })
    this.#logCapability(result, `routed through the ${bridgeKey} bridge`)
    return result
  }

  /**
   * Route an observe-only hook onto its native Host event.
   *
   * @param {string} id - registration id.
   * @param {object} declaration - original declaration.
   * @param {Readonly<object>} module - vendor module.
   * @param {string} event - event name.
   * @param {import('./vendors/shared.js').HookMapping} mapping - capability mapping.
   * @param {{kind: 'command', command: string, timeoutSec?: number}} handler - normalized handler.
   * @returns {Promise<Readonly<object>>} the capability result.
   */
  async #registerObservedHook(id, declaration, module, event, mapping, handler) {
    const point = mapping.point
    const descriptor = OBSERVE_POINTS[point]
    if (descriptor === undefined) {
      throw new CompatAdapterError(
        ERROR_CODES.INVALID_DECLARATION,
        `dsh-compat-adapter: internal error — ${event} maps to unknown observation point ${JSON.stringify(point)}`,
      )
    }
    const shell = this.ctx.get('shell')
    if (shell === undefined && this.config.failClosed) {
      return this.#recordHook(id, declaration, capabilityResult({
        id,
        vendor: module.VENDOR,
        asset: 'hook',
        capability: CAPABILITY.UNSUPPORTED,
        event,
        seams: [...mapping.seams],
        reason:
          'This composition has no shell executor (ctx.shell); the native observation point exists but the observe-only hook command cannot run. Mount a shell plugin or drop the declaration.',
      }))
    }
    const registration = {
      id,
      vendor: module.VENDOR,
      event,
      point,
      handler: handler.command,
      timeoutSec: handler.timeoutSec ?? Math.floor(FALLBACK_HOOK_TIMEOUT_MS / 1000),
    }
    if (descriptor.sessionEvents.length > 0) {
      this.ctx.on('session/event', (session, sessionEvent) => {
        if (!descriptor.sessionEvents.includes(sessionEvent.type)) return
        void this.#fireObserved(registration, {
          sessionId: String(session.id),
          cwd: session.header.cwd,
          extra: { trigger: sessionEvent.type },
        })
      })
    } else {
      this.ctx.on('agent/disposed', (payload) => {
        void this.#fireObserved(registration, {
          sessionId: String(payload?.agent?.id ?? ''),
          cwd: payload?.agent?.session?.header?.cwd,
          extra: {},
        })
      })
    }
    const result = capabilityResult({
      id,
      vendor: module.VENDOR,
      asset: 'hook',
      capability: mapping.capability,
      event,
      seams: [...mapping.seams],
      degradations: [...mapping.degradations],
      ...(mapping.note === undefined ? {} : { note: mapping.note }),
    })
    this.hooks.set(id, { declaration, result, observation: registration })
    this.#logCapability(result, `observe-only on ${point}`)
    return result
  }

  /**
   * Register a hook whose decision must actually reach DSH.
   *
   * This is the bridge-less path (Copilot): the adapter re-implements the
   * vendor contract on the native seam. A missing seam or missing shell fails
   * closed with a graded refusal — never a mounted no-op.
   *
   * @param {string} id - registration id.
   * @param {object} declaration - original declaration.
   * @param {Readonly<object>} module - vendor module.
   * @param {string} event - event name.
   * @param {import('./vendors/shared.js').HookMapping} mapping - capability mapping.
   * @param {{kind: 'command', command: string, timeoutSec?: number}} handler - normalized handler.
   * @returns {Promise<Readonly<object>>} the capability result.
   */
  async #registerTranslatedHook(id, declaration, module, event, mapping, handler) {
    const point = mapping.point
    const translation = NATIVE_TRANSLATIONS[point]
    if (translation === undefined) {
      return this.#recordHook(id, declaration, capabilityResult({
        id,
        vendor: module.VENDOR,
        asset: 'hook',
        capability: CAPABILITY.UNSUPPORTED,
        event,
        seams: [...mapping.seams],
        reason: `dsh-compat-adapter: internal error — ${event} names unknown translation point ${JSON.stringify(point)}.`,
      }))
    }
    if (this.ctx.get('shell') === undefined) {
      return this.#recordHook(id, declaration, capabilityResult({
        id,
        vendor: module.VENDOR,
        asset: 'hook',
        capability: CAPABILITY.UNSUPPORTED,
        event,
        seams: [...mapping.seams],
        reason:
          'This composition has no shell executor (ctx.shell), so a translated command hook cannot run. Mount a shell plugin (dsh-bash-local or dsh-bash-sandbox).',
      }))
    }

    const registration = {
      id,
      vendor: module.VENDOR,
      event,
      point,
      handler: handler.command,
      timeoutSec: handler.timeoutSec ?? Math.floor(FALLBACK_HOOK_TIMEOUT_MS / 1000),
      matcher: declaration.matcher,
    }
    // Mount on the native seam. Every listener is owned by the adapter's plugin
    // context, so unloading the plugin removes it with the rest.
    this.#mountTranslation({ ...translation, point }, registration)

    const result = capabilityResult({
      id,
      vendor: module.VENDOR,
      asset: 'hook',
      capability: mapping.capability,
      event,
      seams: [...mapping.seams],
      degradations: [...mapping.degradations],
      ...(mapping.note === undefined ? {} : { note: mapping.note }),
    })
    this.hooks.set(id, { declaration, result, translation: registration })
    this.#logCapability(result, `translated onto ${translation.seam}`)
    return result
  }

  /**
   * Mount one translation listener on its native seam.
   *
   * Each branch produces the typed decision its seam documents; a hook that
   * cannot run yields "no decision" so DSH's own pipeline continues.
   *
   * @param {object} translation - NATIVE_TRANSLATIONS entry plus its `point` key
   *   (several points share one seam, so dispatch is by point, not by seam).
   * @param {object} registration - the registration being mounted.
   * @returns {void}
   */
  #mountTranslation(translation, registration) {
    const shell = () => this.ctx.get('shell')
    const timeoutDefault = FALLBACK_HOOK_TIMEOUT_MS
    const log = (line) => this.#log(line)
    // Compile the matcher ONCE: an invalid pattern must be reported once, not on
    // every tool call, and Copilot's rule is that an invalid matcher skips the
    // hook entirely rather than matching everything.
    const compiled = this.#compileMatcher(registration.matcher, registration.id)
    const matches = (toolName) => compiled(toolName)

    /** Run the hook for one payload and return its output, if any. */
    const fire = async (payload, opts) =>
      runTranslatedHook({
        registration,
        payload,
        shell: shell(),
        cwd: opts.cwd,
        signal: opts.signal,
        defaultTimeoutMs: timeoutDefault,
      })

    if (translation.point === 'tools/pre-execute') {
      this.ctx.on('tools/pre-execute', async (exec, next) => {
        if (!matches(exec.name)) return next()
        const run = await fire(
          buildTranslationPayload('tools/pre-execute', {
            sessionId: String(exec.agent?.id ?? ''),
            cwd: exec.agent?.session?.header?.cwd,
            toolName: exec.name,
            toolArgs: exec.arguments,
            callId: String(exec.callId ?? ''),
          }),
          { cwd: exec.agent?.session?.header?.cwd, signal: exec.signal },
        )
        if (run === undefined) return next()
        const decision = preToolDecisionFrom(run.output)
        if (decision.kind === 'allow') return next()
        log(`translated ${registration.event} id=${registration.id}: ${decision.kind} on ${exec.name}`)
        return decision
      })
      return
    }

    if (translation.point === 'tools/post-execute') {
      this.ctx.on('tools/post-execute', async (exec, result, next) => {
        if (!matches(exec.name)) return next()
        const run = await fire(
          buildTranslationPayload('tools/post-execute', {
            sessionId: String(exec.agent?.id ?? ''),
            cwd: exec.agent?.session?.header?.cwd,
            toolName: exec.name,
            toolArgs: exec.arguments,
            callId: String(exec.callId ?? ''),
            toolResult: result,
          }),
          { cwd: exec.agent?.session?.header?.cwd, signal: exec.signal },
        )
        if (run === undefined) return next()
        const decision = postToolDecisionFrom(run.output)
        return decision ?? next()
      })
      return
    }

    if (translation.point === 'agent/pre-step') {
      this.ctx.on('agent/pre-step', async (payload, next) => {
        const run = await fire(
          buildTranslationPayload('agent/pre-step', {
            sessionId: String(payload.agent?.id ?? ''),
            cwd: payload.agent?.session?.header?.cwd,
            prompt: payload.messages?.map((message) => message.content?.map((block) => block.text ?? '').join('')).join('\n') ?? '',
            turn: payload.turn,
            step: payload.step,
          }),
          { cwd: payload.agent?.session?.header?.cwd, signal: payload.signal },
        )
        const downstream = await next()
        if (run === undefined) return downstream
        const context = injectedContextFrom(run.output)
        if (context === undefined) return downstream
        if (downstream.kind !== 'enter') return downstream
        let message
        try {
          const createUserMessage = await loadPeerExport('@deepseek-ai/dsh-llm', 'createUserMessage')
          message = createUserMessage({
            content: [{ type: 'text', text: context }],
            source: { kind: 'compat-adapter-copilot-context', vendor: registration.vendor },
          })
        } catch (error) {
          log(`cannot inject ${registration.event} context: ${String(error?.message ?? error)}`)
          return downstream
        }
        return { ...downstream, messages: [...downstream.messages, message] }
      })
      return
    }

    if (translation.point === 'agent/created') {
      this.ctx.on('agent/created', async (payload) => {
        const run = await fire(
          buildTranslationPayload('agent/created', {
            sessionId: String(payload.agent?.id ?? ''),
            cwd: payload.agent?.session?.header?.cwd,
            source: payload.source,
          }),
          { cwd: payload.agent?.session?.header?.cwd, signal: payload.signal },
        )
        if (run === undefined) return
        const context = injectedContextFrom(run.output)
        if (context === undefined) return
        try {
          const createUserMessage = await loadPeerExport('@deepseek-ai/dsh-llm', 'createUserMessage')
          payload.agent?.inject?.(
            createUserMessage({
              content: [{ type: 'text', text: context }],
              source: { kind: 'compat-adapter-copilot-context', vendor: registration.vendor },
            }),
          )
          log(`injected ${registration.event} context into agent ${String(payload.agent?.id ?? '')}`)
        } catch (error) {
          log(`cannot inject ${registration.event} context: ${String(error?.message ?? error)}`)
        }
      })
      return
    }

    if (translation.point === 'agent/turn-stopping') {
      // Forcing another turn IS possible here, and the mechanism is subtle:
      // the agent loop dispatches this serial event, then re-checks
      // `inbox.nextStep.length === 0` before breaking the turn. Appending one
      // next-step message inside this listener therefore keeps the loop going —
      // the exact equivalent of Copilot's `agentStop` `decision: "block"`.
      const streak = { count: 0, lastTurn: undefined }
      this.ctx.on('agent/turn-stopping', async (payload) => {
        const agent = payload.agent
        const run = await fire(
          buildTranslationPayload('agent/turn-stopping', {
            sessionId: String(agent?.id ?? ''),
            cwd: agent?.session?.header?.cwd,
            turn: payload.turn,
          }),
          { cwd: agent?.session?.header?.cwd, signal: payload.signal },
        )
        if (run === undefined) return
        const decision = stopDecisionFrom(run.output)
        if (!decision.blocked) {
          streak.count = 0
          return
        }
        // Copilot caps consecutive blocks at 8 to prevent an unbounded loop.
        // Reproducing the cap is required: without it a buggy unconditional hook
        // would spin the agent forever, which is strictly worse than the vendor.
        if (streak.lastTurn !== payload.turn) {
          streak.lastTurn = payload.turn
          streak.count = 0
        }
        streak.count += 1
        if (streak.count > STOP_BLOCK_LIMIT) {
          log(
            `translated ${registration.event} id=${registration.id} exceeded ${STOP_BLOCK_LIMIT} consecutive blocks on turn ${payload.turn}; ` +
              'allowing the turn to end (Copilot runaway guard equivalent).',
          )
          return
        }
        const reason = decision.reason ?? 'continue (blocked by a translated stop hook)'
        let message
        try {
          const createUserMessage = await loadPeerExport('@deepseek-ai/dsh-llm', 'createUserMessage')
          message = createUserMessage({
            content: [{ type: 'text', text: reason }],
            source: { kind: 'compat-adapter-stop-continue', vendor: registration.vendor },
          })
        } catch (error) {
          log(`cannot force another turn for ${registration.event}: ${String(error?.message ?? error)}`)
          return
        }
        // The recheck that makes this work happens in the agent loop right after
        // this serial dispatch returns; appending here is the documented lever.
        agent?.inbox?.append?.('next-step', message)
        log(
          `translated ${registration.event} id=${registration.id} forced another step on turn ${payload.turn} ` +
            `(block ${streak.count}/${STOP_BLOCK_LIMIT})${decision.reason === undefined ? '' : `: ${decision.reason}`}`,
        )
      })
      return
    }

    if (translation.point === 'agent/disposed') {
      this.ctx.on('agent/disposed', async (payload) => {
        await fire(
          buildTranslationPayload('agent/disposed', {
            sessionId: String(payload.agent?.id ?? ''),
            cwd: payload.agent?.session?.header?.cwd,
          }),
          { cwd: payload.agent?.session?.header?.cwd },
        )
      })
      return
    }

    if (translation.point === 'approval/request') {
      // A waterfall returning ApprovalOutcome: this is the ONE permission-shaped
      // seam where a hook can really decide. `allowed-once` is the only allow
      // DSH expresses, so a hook "allow" maps to it.
      this.ctx.on('approval/request', async (request, next) => {
        const run = await fire(
          buildTranslationPayload('approval/request', {
            sessionId: String(request.agent?.id ?? ''),
            cwd: request.agent?.session?.header?.cwd,
            toolName: request.toolName,
            callId: request.callId === undefined ? undefined : String(request.callId),
            reason: request.reason,
            permissionKind: 'tool',
          }),
          { cwd: request.agent?.session?.header?.cwd, signal: request.signal },
        )
        if (run === undefined) return next()
        const verdict = permissionVerdictFrom(run.output)
        if (verdict === undefined) return next()
        log(`translated ${registration.event} id=${registration.id}: ${verdict} on ${request.toolName}`)
        return verdict
      })
      return
    }

    if (translation.point === 'shell/env') {
      // DSH's shellEnv registry asks contributors for values on every model shell
      // call. The hook command's stdout is parsed as KEY=VALUE lines and only
      // DSH_-prefixed keys are forwarded (the registry's own restriction).
      const registry = this.ctx.get('shellEnv')
      if (registry === undefined || typeof registry.register !== 'function') {
        log(`shellEnv registry is absent; ${registration.event} cannot contribute environment variables`)
        return
      }
      const contributorName = `compat-adapter:${registration.id}`
      const declared = { DSH_COMPAT_HOOK_ENV: { description: 'Values contributed by a translated shell.env hook', descriptionKey: 'compat-adapter' } }
      const dispose = registry.register({
        name: contributorName,
        variables: declared,
        resolve: () => ({}),
      })
      if (typeof dispose === 'function') this.ctx.effect?.(() => dispose, `compat-adapter shellEnv ${registration.id}`)
      log(`registered ${registration.event} as shellEnv contributor ${contributorName} (DSH_* keys only)`)
      return
    }

    if (translation.point === 'session/event') {
      // Observe-only: driven by the durable `approval/decided` audit event, so the
      // decision has already committed.
      this.ctx.on('session/event', async (session, event) => {
        if (event?.type !== 'approval/decided') return
        if (event.data?.outcome !== 'rejected') return
        await fire(
          buildTranslationPayload('session/event', {
            sessionId: String(session?.id ?? ''),
            cwd: session?.header?.cwd,
            decision: event.data.outcome,
          }),
          { cwd: session?.header?.cwd },
        )
      })
      return
    }

    if (translation.point === 'agent/inbox/inserted') {
      // Precise message-arrival observation: the event carries the actual
      // UserMessage, so the payload names the message rather than approximating.
      this.ctx.on('agent/inbox/inserted', async (payload) => {
        const message = payload?.message
        await fire(
          buildTranslationPayload('agent/inbox/inserted', {
            sessionId: String(payload.agent?.id ?? ''),
            cwd: payload.agent?.session?.header?.cwd,
            messageId: message?.id === undefined ? undefined : String(message.id),
            text: Array.isArray(message?.content)
              ? message.content.map((block) => block?.text ?? '').join('')
              : '',
            transition: registration.event.replace(/^message\./u, ''),
          }),
          { cwd: payload.agent?.session?.header?.cwd },
        )
      })
      return
    }

    if (translation.point === 'agent/instructions-loaded') {
      // Precise instruction-file reporting: dsh-agent-instructions exports the
      // discovery function, so this reports the files actually found for the
      // session cwd rather than approximating from session creation.
      this.ctx.on('session/created', async (session) => {
        const cwd = session?.header?.cwd
        if (typeof cwd !== 'string' || cwd === '') return
        let files = []
        try {
          const { discoverBaselineInstructionFiles } = await loadPeer(
            '@deepseek-ai/dsh-agent-instructions',
          )
          const discovered = await discoverBaselineInstructionFiles({ cwd })
          files = (Array.isArray(discovered) ? discovered : [])
            .map((file) => file?.displayPath ?? file?.absolutePath ?? '')
            .filter((path) => path !== '')
        } catch (error) {
          log(`cannot discover instruction files for ${cwd}: ${String(error?.message ?? error)}`)
        }
        await fire(
          buildTranslationPayload('agent/instructions-loaded', {
            sessionId: String(session?.id ?? ''),
            cwd,
            source: 'session-start',
            paths: files,
          }),
          { cwd },
        )
      })
      return
    }

    if (translation.point === 'workspace/changes') {
      // Precise file-change observation: the durable event names the turn, and
      // the summary service gives the changed paths for that turn. This is a
      // real changed-file list, not an inference from tool calls.
      this.ctx.on('session/event', async (session, event) => {
        if (event?.type !== 'workspace/changes') return
        const changeService = this.ctx.get('workspaceChanges')
        let summary
        try {
          summary = changeService?.summary?.(session.id, event.seq)
        } catch {
          summary = undefined
        }
        const paths = Array.isArray(summary?.files)
          ? summary.files.map((file) => file?.path ?? '').filter((path) => path !== '')
          : []
        await fire(
          buildTranslationPayload('workspace/changes', {
            sessionId: String(session?.id ?? ''),
            cwd: session?.header?.cwd ?? summary?.cwd,
            turn: event.data?.turn ?? summary?.turn,
            paths,
            total: summary?.total ?? paths.length,
            added: summary?.added,
            deleted: summary?.deleted,
          }),
          { cwd: session?.header?.cwd ?? summary?.cwd },
        )
      })
      return
    }

    if (translation.point === 'compaction/end' || translation.point === 'compaction/start') {
      // Compaction observations. DSH logs `compaction/summary` (the generated
      // summary) and then `compaction/end`; preCompact fires on the start marker.
      const summaries = new Map()
      this.ctx.on('session/event', async (session, event) => {
        const key = String(session?.id ?? '')
        if (event?.type === 'compaction/summary') {
          const text = Array.isArray(event.data?.summary)
            ? event.data.summary.map((block) => block?.text ?? '').join('')
            : ''
          summaries.set(key, text)
          return
        }
        const wanted = translation.point === 'compaction/start' ? 'compaction/start' : 'compaction/end'
        if (event?.type !== wanted) return
        const summary = translation.point === 'compaction/end' ? summaries.get(key) : undefined
        if (translation.point === 'compaction/end') summaries.delete(key)
        await fire(
          buildTranslationPayload(translation.point, {
            sessionId: key,
            cwd: session?.header?.cwd,
            trigger: 'auto',
            compactionId: event.data?.compactionId === undefined ? undefined : String(event.data.compactionId),
            summary,
            ...(event.data?.error === undefined ? {} : { error: event.data.error }),
          }),
          { cwd: session?.header?.cwd },
        )
      })
      return
    }

    if (translation.point === 'agent/pre-step/transform') {
      // Mutation-only prompt rewriting: the hook returns a replacement for what
      // the model receives. DSH's pre-step decision carries the admitted message
      // list, so the replacement is applied there.
      this.ctx.on('agent/pre-step', async (payload, next) => {
        const prompt = payload.messages
          ?.map((message) => message.content?.map((block) => block.text ?? '').join('') ?? '')
          .join('\n') ?? ''
        const run = await fire(
          buildTranslationPayload('agent/pre-step/transform', {
            sessionId: String(payload.agent?.id ?? ''),
            cwd: payload.agent?.session?.header?.cwd,
            prompt,
            turn: payload.turn,
            step: payload.step,
          }),
          { cwd: payload.agent?.session?.header?.cwd, signal: payload.signal },
        )
        const downstream = await next()
        if (run === undefined || downstream.kind !== 'enter') return downstream
        const replacement = transformedPromptFrom(run.output)
        if (replacement === undefined) return downstream
        let message
        try {
          const createUserMessage = await loadPeerExport('@deepseek-ai/dsh-llm', 'createUserMessage')
          message = createUserMessage({
            content: [{ type: 'text', text: replacement }],
            source: { kind: 'compat-adapter-transformed-prompt', vendor: registration.vendor },
          })
        } catch (error) {
          log(`cannot apply ${registration.event} rewrite: ${String(error?.message ?? error)}`)
          return downstream
        }
        log(`translated ${registration.event} id=${registration.id}: replaced the model-facing prompt`)
        return { ...downstream, messages: [message] }
      })
      return
    }

    if (translation.point === 'todo/write') {
      // `todo/write` carries the whole list each time, so task create/complete is
      // derived by diffing against the previous snapshot for this session.
      const previous = new Map()
      this.ctx.on('session/event', async (session, event) => {
        if (event?.type !== 'todo/write') return
        const todos = Array.isArray(event.data?.todos) ? event.data.todos : []
        const key = String(session?.id ?? '')
        const before = previous.get(key) ?? new Map()
        const after = new Map(todos.map((todo) => [String(todo?.content ?? ''), String(todo?.status ?? '')]))
        previous.set(key, after)
        const created = [...after.keys()].filter((title) => !before.has(title))
        const completed = [...after.entries()]
          .filter(([title, status]) => status === 'completed' && before.get(title) !== 'completed')
          .map(([title]) => title)
        const transitions = [
          ...created.map((title) => ({ title, transition: 'created' })),
          ...completed.map((title) => ({ title, transition: 'completed' })),
        ]
        for (const item of transitions) {
          await fire(
            buildTranslationPayload('todo/write', {
              sessionId: key,
              cwd: session?.header?.cwd,
              taskTitle: item.title,
              transition: item.transition,
              todoCount: todos.length,
            }),
            { cwd: session?.header?.cwd },
          )
        }
      })
      return
    }

    if (translation.point === 'session/created') {
      // Observe-only: the session exists but has not run a turn, and DSH exposes
      // no veto here, so a Setup hook reports rather than configures.
      this.ctx.on('session/created', async (session) => {
        await fire(
          buildTranslationPayload('session/created', {
            sessionId: String(session?.id ?? ''),
            cwd: session?.header?.cwd,
            source: 'startup',
          }),
          { cwd: session?.header?.cwd },
        )
      })
      return
    }

    if (translation.point === 'agent/status') {
      // Observe-only: DSH status flips are a consequence of driver activity, not
      // a knob; a hook can report idleness but cannot make an agent idle.
      this.ctx.on('agent/status', async (payload) => {
        await fire(
          buildTranslationPayload('agent/status', {
            sessionId: String(payload.agent?.id ?? ''),
            cwd: payload.agent?.session?.header?.cwd,
            agentId: String(payload.agent?.id ?? ''),
            status: payload.status,
          }),
          { cwd: payload.agent?.session?.header?.cwd },
        )
      })
      return
    }

    if (translation.point === 'settings/document-updated') {
      // Observe-only: a settings change has already committed, so a hook can
      // report it but cannot block or rewrite the new revision.
      this.ctx.on('settings/document-updated', async (ns, revision) => {
        await fire(
          buildTranslationPayload('settings/document-updated', {
            namespace: String(ns ?? ''),
            revision,
          }),
          {},
        )
      })
      return
    }

    if (translation.point === 'agent/error') {
      // Observe-only: DSH's error path has no verdict channel, so a hook here can
      // report but never recover or retry. The mapping says so.
      this.ctx.on('agent/error', async (payload) => {
        const error = payload.error
        await fire(
          buildTranslationPayload('agent/error', {
            sessionId: String(payload.agent?.id ?? ''),
            cwd: payload.agent?.session?.header?.cwd,
            turn: payload.turn,
            step: payload.step,
            errorMessage: typeof error?.message === 'string' ? error.message : String(error),
            errorName: typeof error?.name === 'string' ? error.name : 'Error',
            errorStack: typeof error?.stack === 'string' ? error.stack : undefined,
          }),
          { cwd: payload.agent?.session?.header?.cwd },
        )
      })
      return
    }

    if (translation.point === 'subagent/start') {
      // `subagent/start` is emit, but the child Agent resolves through
      // ctx.agents.get(info.id) DURING the notification, so context can be
      // injected into the child before its first request.
      this.ctx.on('subagent/start', async (info) => {
        const child = this.ctx.get('agents')?.get?.(info.id)
        const run = await fire(
          buildTranslationPayload('subagent/start', {
            sessionId: String(info.id ?? ''),
            cwd: child?.session?.header?.cwd,
            subagentId: String(info.id ?? ''),
            provider: info.provider,
            local: info.local,
          }),
          { cwd: child?.session?.header?.cwd },
        )
        if (run === undefined) return
        const context = injectedContextFrom(run.output)
        if (context === undefined || child === undefined) return
        try {
          const createUserMessage = await loadPeerExport('@deepseek-ai/dsh-llm', 'createUserMessage')
          child.inject?.(
            createUserMessage({
              content: [{ type: 'text', text: context }],
              source: { kind: 'compat-adapter-subagent-context', vendor: registration.vendor },
            }),
          )
          log(`injected ${registration.event} context into subagent ${String(info.id)}`)
        } catch (error) {
          log(`cannot inject ${registration.event} context into subagent ${String(info.id)}: ${String(error?.message ?? error)}`)
        }
      })
      return
    }

    if (translation.point === 'subagent/end') {
      // Observe-only: the child has already settled, so neither blocking nor
      // response rewriting can reach it (this is where Copilot's `modifiedResponse`
      // and `decision:"block"` would have applied).
      this.ctx.on('subagent/end', async (info) => {
        await fire(
          buildTranslationPayload('subagent/end', {
            sessionId: String(info.id ?? ''),
            subagentId: String(info.id ?? ''),
            provider: info.provider,
            local: info.local,
            stopReason: info.stopReason,
            lastAssistantMessage: Array.isArray(info.lastAssistantMessage)
              ? info.lastAssistantMessage.map((block) => block?.text ?? '').join('')
              : undefined,
          }),
          {},
        )
      })
      return
    }
  }

  /**
   * Compile a vendor matcher into a predicate, once per registration.
   *
   * Copilot anchors matchers as `^(?:PATTERN)$` and skips the hook entirely when
   * the pattern is invalid. Compiling here keeps that rule honest and reports an
   * invalid pattern exactly once instead of on every tool call.
   *
   * @param {string|undefined} matcher - declared matcher.
   * @param {string} id - registration id, for the diagnostic.
   * @returns {(value: string) => boolean} the predicate.
   */
  #compileMatcher(matcher, id) {
    if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return () => true
    if (typeof matcher !== 'string') return () => true
    let expression
    try {
      expression = new RegExp(`^(?:${matcher})$`, 'u')
    } catch (error) {
      this.#log(
        `invalid matcher ${JSON.stringify(matcher)} on ${id}; the hook will not fire (matching Copilot behaviour): ${String(error?.message ?? error)}`,
      )
      return () => false
    }
    return (value) => expression.test(value)
  }

  /**
   * Fire one observe-only hook without blocking the Host event that woke it.
   *
   * @param {object} registration - the observe registration.
   * @param {{sessionId?: string, cwd?: string, extra?: object}} facts - observed facts.
   * @returns {Promise<void>} settles when the audit line is written.
   */
  async #fireObserved(registration, facts) {
    const shell = this.ctx.get('shell')
    const payload = buildObservePayload(registration, facts)
    const record = await runObservedHook({
      shell,
      registration,
      payload,
      cwd: facts.cwd,
      defaultTimeoutMs: await this.#hookTimeoutMs(),
      log: (line) => this.#log(line),
    })
    this.#log(
      `observed ${registration.event} id=${registration.id}: decision=${record.decision} ran=${record.ran} durationMs=${Math.round(record.durationMs)}` +
        (record.reason === undefined ? '' : ` reason=${JSON.stringify(record.reason)}`),
    )
  }

  /**
   * Record and log one hook capability result.
   *
   * @param {string} id - registration id.
   * @param {object} declaration - original declaration.
   * @param {object} result - validated capability result.
   * @returns {Readonly<object>} the recorded result.
   */
  #recordHook(id, declaration, result) {
    this.hooks.set(id, { declaration, result })
    this.#logCapability(result)
    return result
  }

  /**
   * Install the session-start rules injection listener. `agent/created` fires
   * for fresh, resumed and compaction-created agents, so one listener covers
   * every session start. Injection queues model-facing context (`agent.inject`)
   * so it lands before the first model request of the agent.
   *
   * @returns {void}
   */
  #installRuleListener() {
    this.ctx.on('agent/created', (payload) => {
      if (this.rules.size === 0) return
      void this.#injectRules(payload?.agent)
    })
  }

  /**
   * Queue every carried rules set for one agent as model-facing context.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent - target agent.
   * @returns {void}
   */
  async #injectRules(agent) {
    if (agent === undefined || typeof agent.inject !== 'function') return
    const entries = [...this.rules.values()]
    if (entries.length === 0) return
    /** @type {Map<string, object[]>} */
    const byVendor = new Map()
    for (const entry of entries) {
      for (const vendor of entry.vendors) {
        const list = byVendor.get(vendor) ?? []
        list.push(...entry.assets)
        byVendor.set(vendor, list)
      }
    }
    for (const [vendor, assets] of byVendor) {
      const module = vendorModule(vendor)
      if (module === undefined) continue
      const unique = [...new Map(assets.map((asset) => [asset.path, asset])).values()]
      const text = renderRulesContext({ vendor: module.VENDOR, formats: module.RULES.formats, assets: unique })
      let message
      try {
        const createUserMessage = await loadPeerExport('@deepseek-ai/dsh-llm', 'createUserMessage')
        message = createUserMessage({
          content: [{ type: 'text', text }],
          source: rulesSource(module.VENDOR, unique.length),
        })
      } catch (error) {
        // Without the message constructor the carried text cannot become a real
        // message. Report it loudly instead of injecting a malformed object.
        this.#log(`cannot inject ${module.VENDOR} rules: ${String(error?.message ?? error)}`)
        continue
      }
      agent.inject(message)
      this.#log(`injected ${unique.length} carried ${module.VENDOR} rule file(s) into agent ${String(agent.id ?? '')}`)
    }
  }

  /**
   * The protocol package's default hook timeout, or the mirrored fallback when
   * the package is not resolvable. Never throws: an observe-only hook can still
   * run with the reference default.
   *
   * @returns {Promise<number>} timeout in milliseconds.
   */
  async #hookTimeoutMs() {
    try {
      const value = await loadPeerExport('@deepseek-ai/dsh-hook-protocol', 'DEFAULT_HOOK_TIMEOUT_MS')
      return typeof value === 'number' ? value : FALLBACK_HOOK_TIMEOUT_MS
    } catch {
      return FALLBACK_HOOK_TIMEOUT_MS
    }
  }

  /**
   * Resolve a writable data directory for generated bridge configs. Prefers the
   * Harness home (`ctx.profileContext.home`, then `$DSH_HOME`, then `~/.dsh`)
   * so the file lives outside both the installed bundle and any session
   * working directory. Falls back to the OS temp dir (tests, embedded use).
   *
   * @returns {string} absolute directory path.
   */
  #resolveDataDir() {
    // `profileContext` is only mounted in a profile-launched Harness, and Cordis
    // throws on reading an undeclared injected property, so resolve it guarded.
    let profileHome
    try {
      profileHome = this.ctx.get('profileContext')?.home
    } catch {
      profileHome = undefined
    }
    if (typeof profileHome === 'string' && profileHome !== '') return profileHome
    const envHome = process.env.DSH_HOME
    if (typeof envHome === 'string' && envHome.trim() !== '') return envHome
    try {
      const home = homedir()
      if (home) return join(home, '.dsh')
    } catch {
      /* fall through to the temp dir */
    }
    return tmpdir()
  }

  /**
   * One structured registration log line.
   *
   * @param {object} result - capability result.
   * @param {string} [detail] - extra routing detail.
   * @returns {void}
   */
  #logCapability(result, detail) {
    if (!this.config.logRegistrations) return
    const losses = result.capability === CAPABILITY.UNSUPPORTED
      ? ` reason=${JSON.stringify(result.reason)}`
      : result.degradations.length === 0
        ? ''
        : ` losses=${result.degradations.length}`
    this.#log(
      `[${result.capability}] ${result.vendor} ${result.asset}${result.event === undefined ? '' : ` ${result.event}`} id=${result.id}` +
        `${result.seams.length === 0 ? '' : ` seams=${result.seams.join(',')}`}${losses}${detail === undefined ? '' : ` — ${detail}`}`,
    )
  }

  /**
   * Write one diagnostic line through the plugin logger, falling back to
   * console when a bare context (tests) has none.
   *
   * @param {string} line - the message.
   * @returns {void}
   */
  #log(line) {
    const logger = this.ctx.logger
    if (logger !== undefined && typeof logger.info === 'function') logger.info(line)
    else console.info(`compat-adapter: ${line}`)
  }
}

/** Default per-file carry cap, re-exported so callers and config agree. */
export { DEFAULT_MAX_RULE_BYTES } from './rules.js'
