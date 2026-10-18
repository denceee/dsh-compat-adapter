/**
 * A REAL Copilot hook bridge, built by this plugin.
 *
 * DSH ships bridges for Claude Code and Codex but none for GitHub Copilot, so
 * this module supplies the missing one with the SAME contract the official
 * bridges follow (`name` / `inject` / `Config` / `apply`), so it can be mounted
 * exactly like them:
 *
 *   ctx.plugin(copilotBridge, { configPath })
 *
 * What makes this a bridge rather than the inline translation it replaces:
 *
 * 1. **Wire protocol is reused, not re-implemented.** Matching, command
 *    execution and output decoding come from `@deepseek-ai/dsh-hook-protocol`
 *    (`matchesMatcher` / `runHook` / `parseHookOutput` / `mergeHookOutputs`), the
 *    same library the official bridges use.
 * 2. **Durable audit records.** Every invocation writes the log-only
 *    `hook/invoked` and `hook/result` session events through `appendHookInvoked`
 *    / `appendHookResult`, so a Copilot hook is auditable the same way a Claude
 *    or Codex hook is.
 * 3. **It owns Copilot's dialect.** Copilot writes its decision at the TOP level
 *    (`{permissionDecision, permissionDecisionReason, modifiedArgs}`) and uses
 *    lowerCamelCase event names plus `bash`/`powershell`/`command`/`exec` command
 *    fields. Those facts live here, not scattered across vendor tables.
 * 4. **A real config file.** Copilot's format is
 *    `{"version":1,"hooks":{"preToolUse":[{type,bash,powershell,command,matcher,timeoutSec}]}}`,
 *    so the bridge parses that format rather than a synthesized subset.
 *
 * The one honest limit is stated in `DIALECT_LIMITS` below and repeated in each
 * vendor row's degradations: `modifiedArgs` (tool-argument rewriting) is parsed
 * but not honored, because DSH's tool seam has no input-rewrite channel.
 *
 * @module dsh-compat-adapter/bridges/copilot
 */

import { readFileSync } from 'node:fs'
import { loadPeer, loadPeerExport } from '../peer.js'
import { loadCorpus } from './shared.js'

/**
 * Consecutive stop-blocks allowed before the bridge stops forcing turns.
 * Mirrors Copilot's own runaway guard.
 */
const STOP_BLOCK_LIMIT = 8

/** Bridge identity, matching the official bridges' export shape. */
export const name = 'hooks-copilot'

/**
 * Services this bridge needs. Mirrors the official bridges: a shell executor to
 * run command hooks, and the projection service the audit helpers reach through
 * their callers' sessions.
 */
export const inject = ['shell', 'sessionProjections']

/** Facts about the Copilot dialect this bridge owns. Surfaced for tests/README. */
export const DIALECT_LIMITS = Object.freeze({
  /** Copilot writes the decision at the TOP level, unlike Claude/Codex. */
  decisionLocation: 'top-level permissionDecision',
  /** Matchers are always anchored regular expressions. */
  matcherMode: 'regex',
  /** Command fields Copilot accepts, in its documented precedence order. */
  commandFields: Object.freeze(['bash', 'powershell', 'command']),
  /** Parsed but not honored, because DSH has no tool-input rewrite channel. */
  unhonored: Object.freeze(['modifiedArgs']),
})

/**
 * The producer source stamped on context this bridge injects, mirroring the
 * official bridges' `{kind:'hooks-claude-code'}`.
 */
export const CONTEXT_SOURCE = Object.freeze({ kind: 'hooks-copilot' })

/** Config schema, resolved lazily so the package imports with no static peers. */
export const Config = await (async () => {
  try {
    const z = (await loadPeer('@deepseek-ai/schemastery')).default
    return z.object({
      configPath: z.string().required(),
      defaultTimeoutMs: z.number().default(600_000),
      stderrSummaryMaxChars: z.number().default(2_000),
    })
  } catch {
    return (input) => {
      const value = input ?? {}
      if (typeof value.configPath !== 'string' || value.configPath === '') {
        throw new TypeError('hooks-copilot: configPath must be a non-empty string')
      }
      return {
        configPath: value.configPath,
        defaultTimeoutMs: value.defaultTimeoutMs ?? 600_000,
        stderrSummaryMaxChars: value.stderrSummaryMaxChars ?? 2_000,
      }
    }
  }
})()

/**
 * Pick the command line for this platform from one Copilot entry.
 *
 * Copilot documents `bash` (Unix), `powershell` (Windows) and `command` as the
 * cross-platform fallback copied to both. `exec`/`args` runs a program without a
 * shell; the protocol runner takes a command line, so `exec` is rendered as a
 * safely-quoted argv line rather than silently dropped.
 *
 * @param {object} entry - one Copilot hook entry.
 * @param {string} [platform] - `process.platform` override (tests).
 * @returns {string|undefined} the command line, or undefined when the entry has none.
 */
export function commandFor(entry, platform = process.platform) {
  if (entry === null || typeof entry !== 'object') return undefined
  if (typeof entry.exec === 'string' && entry.exec !== '') {
    return [entry.exec, ...(Array.isArray(entry.args) ? entry.args.map((value) => String(value)) : [])]
      .map((value) => (/[\s"'\\$]/.test(value) ? `'${value.replace(/'/gu, "'\\''")}'` : value))
      .join(' ')
  }
  const isWindows = platform === 'win32'
  const preferred = isWindows ? entry.powershell : entry.bash
  if (typeof preferred === 'string' && preferred !== '') return preferred
  if (typeof entry.command === 'string' && entry.command !== '') return entry.command
  return undefined
}

/**
 * Parse Copilot's hook config into the protocol's matcher-group shape.
 *
 * Copilot's envelope is `{"version":1,"disableAllHooks"?, "hooks":{...}}`. The
 * per-event list holds command entries; only command entries are executable, and
 * a malformed entry is dropped while siblings survive (matching Copilot, which
 * logs and skips a bad item rather than rejecting the file).
 *
 * @param {unknown} parsed - the parsed JSON document.
 * @returns {{hooks: Record<string, Array<{matcher?: string, hooks: Array<{command: string, timeoutSec?: number}>}>>, disabled: boolean}} the group map.
 */
export function parseCopilotConfig(parsed) {
  const document = parsed !== null && typeof parsed === 'object' ? parsed : {}
  const disabled = document.disableAllHooks === true
  const rawHooks = document.hooks !== null && typeof document.hooks === 'object' ? document.hooks : {}
  /** @type {Record<string, Array<{matcher?: string, hooks: Array<{command: string, timeoutSec?: number}>}>>} */
  const hooks = {}
  for (const [event, entries] of Object.entries(rawHooks)) {
    if (!Array.isArray(entries)) continue
    const groups = []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const type = entry.type ?? 'command'
      // Only command hooks run; prompt / http / agent entries are parsed-and-skipped
      // by both official bridges too.
      if (type !== 'command') continue
      const command = commandFor(entry)
      if (command === undefined) continue
      const timeout = typeof entry.timeoutSec === 'number' ? entry.timeoutSec : typeof entry.timeout === 'number' ? entry.timeout : undefined
      const group = {
        ...(typeof entry.matcher === 'string' ? { matcher: entry.matcher } : {}),
        hooks: [{ command, ...(timeout === undefined ? {} : { timeoutSec: timeout }) }],
      }
      groups.push(group)
    }
    if (groups.length > 0) hooks[event] = groups
  }
  return { hooks, disabled }
}

/**
 * Coerce a merged `additionalContext` into one string.
 *
 * `mergeHookOutputs` accumulates several hooks' context, so the merged value is
 * an ARRAY when more than one hook contributed. Copilot's contract is one string
 * per hook joined by a blank line, so the array is joined here rather than passed
 * on in a shape the injection path cannot use.
 *
 * @param {unknown} value - the merged additional-context value.
 * @returns {string|undefined} the joined context, or undefined when empty.
 */
export function joinedContext(value) {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value
  if (Array.isArray(value)) {
    const parts = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    return parts.length === 0 ? undefined : parts.join('\n\n')
  }
  return undefined
}

/**
 * Normalize one decoded output into the shared dialect-neutral shape.
 *
 * This is the crux of bridging Copilot: the protocol decoder recognizes only
 * `hookSpecificOutput.permissionDecision` (the Claude/Codex dialect), while
 * Copilot writes `permissionDecision` at the TOP level. It also writes
 * `modifiedArgs` and a bare `decision: "block"` for stop hooks. Reusing the
 * decoder without this step would silently drop every Copilot decision.
 *
 * @param {object} output - the protocol-decoded output.
 * @returns {object} a copy carrying the Copilot decision in the neutral fields.
 */
export function normalizeDialect(output) {
  const raw = typeof output?.stdout === 'string' ? output.stdout.trim() : ''
  if (raw === '' || !raw.startsWith('{')) return output
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return output
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return output
  // A Claude-shaped payload is already understood by the decoder.
  if (parsed.hookSpecificOutput !== undefined) return output

  const normalized = { ...output }
  const permission = parsed.permissionDecision
  if (permission === 'allow' || permission === 'deny' || permission === 'ask') normalized.decision = permission
  else if (permission === 'block') normalized.decision = 'block'
  else if (parsed.decision === 'block' || parsed.decision === 'allow') normalized.decision = parsed.decision

  const reason =
    typeof parsed.permissionDecisionReason === 'string' && parsed.permissionDecisionReason !== ''
      ? parsed.permissionDecisionReason
      : typeof parsed.reason === 'string' && parsed.reason !== ''
        ? parsed.reason
        : undefined
  if (reason !== undefined) normalized.reason = reason

  if (typeof parsed.additionalContext === 'string' && parsed.additionalContext !== '') {
    normalized.additionalContext = parsed.additionalContext
  }
  // Parsed, reported, but not honored: DSH has no tool-input rewrite channel.
  if (parsed.modifiedArgs !== null && typeof parsed.modifiedArgs === 'object') {
    normalized.updatedInput = parsed.modifiedArgs
  }
  return normalized
}

/**
 * Read stdin payloads the way Copilot documents them, tolerating BOTH the native
 * camelCase shape and the VS Code-compatible snake_case shape, because Copilot
 * itself accepts either depending on how the hook was declared.
 *
 * @param {object} exec - a DSH tool execution.
 * @returns {object} the payload object.
 */
export function copilotToolPayload(exec) {
  return {
    sessionId: String(exec.agent?.id ?? ''),
    timestamp: Date.now(),
    cwd: exec.agent?.session?.header?.cwd ?? process.cwd(),
    toolName: exec.name,
    toolArgs: exec.arguments ?? {},
    ...(exec.callId === undefined ? {} : { toolCallId: String(exec.callId) }),
    // VS Code compatible aliases, so a hook written against either shape works.
    hook_event_name: 'PreToolUse',
    tool_name: exec.name,
    tool_input: exec.arguments ?? {},
  }
}

/**
 * Mount the bridge. Mirrors the official bridges' `apply`: read one config at
 * activation, register listeners on the interception points, and write durable
 * audit events for every invocation.
 *
 * @param {import('@deepseek-ai/dsh-cordis').Context} ctx - the mounting context.
 * @param {{configPath: string, defaultTimeoutMs?: number, stderrSummaryMaxChars?: number}} config - validated config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const defaultTimeoutMs = config.defaultTimeoutMs ?? 600_000
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? 2_000
  let parsed = { hooks: {}, disabled: false }
  try {
    parsed = parseCopilotConfig(JSON.parse(readFileSync(config.configPath, 'utf8')))
  } catch (error) {
    ctx.logger?.warn?.(`hooks-copilot: cannot read ${config.configPath}: ${String(error?.message ?? error)}`)
    return
  }
  if (parsed.disabled) {
    ctx.logger?.info?.('hooks-copilot: disableAllHooks is set; no Copilot hook will run')
    return
  }
  // Listeners are registered SYNCHRONOUSLY. Cordis only permits `ctx.on` while
  // the mounting fiber is still running; awaiting the peer imports first would
  // land inside an inactive fiber ("cannot create effect on inactive context")
  // and every listener would silently fail to attach. The peers are therefore
  // resolved lazily inside each callback, memoised by the shared loader.
  mount(ctx, parsed, { defaultTimeoutMs, stderrSummaryMaxChars })
}

/**
 * Install the listeners. Kept separate from `apply` so the async peer loading
 * happens after the config was read synchronously.
 *
 * @param {object} ctx - mounting context.
 * @param {object} parsed - parsed config.
 * @param {object} options - resolved options.
 * @returns {Promise<void>} settles once listeners are registered.
 */
function mount(ctx, parsed, options) {
  /** Memoised peer resolution: the imports happen on first use, not at mount. */
  let peersPromise
  const peers = () => {
    peersPromise ??= (async () => {
      const protocol = await loadPeer('@deepseek-ai/dsh-hook-protocol')
      const { createUserMessage } = await loadPeer('@deepseek-ai/dsh-llm')
      const corpus = await loadCorpus().catch(() => undefined)
      return { protocol, createUserMessage, corpus }
    })()
    return peersPromise
  }

  let handlerCounter = 0
  /** Run every group matching `query` for one event point. */
  const runPoint = async (point, query, payload, opts) => {
    const { protocol, corpus } = await peers()
    const { matchesMatcher, runHook, mergeHookOutputs, appendHookInvoked, appendHookResult, DEFAULT_HOOK_TIMEOUT_MS } = protocol
    const groups = parsed.hooks[point] ?? []
    const outputs = []
    for (const group of groups) {
      const match = corpus === undefined
        ? matchesMatcher(group.matcher, query, 'codex')
        : corpus.matches(group.matcher, query)
      if (!match) continue
      for (const hook of group.hooks) {
        handlerCounter += 1
        const handlerId = `copilot:${point}:${handlerCounter}`
        const session = opts.agent?.session
        const turn = opts.turn
        if (session !== undefined && turn !== undefined) {
          appendHookInvoked(session, {
            turn, point, dialect: 'codex', handlerId,
            ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
          })
        }
        const { output, durationMs } = await runHook(
          ctx.shell,
          hook,
          {
            payload,
            defaultTimeoutMs: options.defaultTimeoutMs || DEFAULT_HOOK_TIMEOUT_MS,
            ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
            signal: opts.signal ?? new AbortController().signal,
            trailingNewline: true,
            expectedEventName: point,
          },
          () => performance.now(),
        )
        // Copilot writes its decision at the TOP LEVEL, which the shared
        // protocol decoder does not recognize (it only reads
        // `hookSpecificOutput.permissionDecision`). Without this normalization
        // every Copilot deny would be read as "no decision" and let through.
        const normalized = normalizeDialect(output)
        outputs.push(normalized)
        if (session !== undefined && turn !== undefined) {
          appendHookResult(session, {
            turn, point, handlerId, output: normalized,
            stderrSummaryMaxChars: options.stderrSummaryMaxChars,
            durationMs,
          })
        }
        if (normalized.updatedInput !== undefined) {
          ctx.logger?.warn?.(`hooks-copilot: ${point} hook requested updatedInput, which is not honored (ignored)`)
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  if (typeof ctx.on !== 'function') return

  /** Send a context message into an agent or child, sourced as this bridge. */
  const injectContext = async (target, text) => {
    if (typeof target?.inject !== 'function' || typeof text !== 'string' || text.trim() === '') return
    try {
      const { createUserMessage } = await peers()
      target.inject(createUserMessage({ content: [{ type: 'text', text }], source: { ...CONTEXT_SOURCE, form: 'instructions' } }))
    } catch (error) {
      ctx.logger?.warn?.(`hooks-copilot: cannot inject context: ${String(error?.message ?? error)}`)
    }
  }

  // ── Pre-tool: the real decision channel ────────────────────────────────
  ctx.on('tools/pre-execute', async (exec, next) => {
    const merged = await runPoint('preToolUse', exec.name, copilotToolPayload(exec), {
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      turn: undefined,
      cwd: exec.agent?.session?.header?.cwd,
      signal: exec.signal,
    })
    if (merged.decision === 'deny' || merged.decision === 'block') {
      return { kind: 'deny', reason: merged.reason ?? 'blocked by preToolUse hook' }
    }
    if (merged.decision === 'ask') {
      return { kind: 'ask', ...(merged.reason === undefined ? {} : { reason: merged.reason }) }
    }
    return next()
  })

  // ── Post-tool: context plus observe-only error variant ─────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const failed = result?.isError === true
    // Copilot splits successes and failures; DSH has one waterfall, so the
    // failure-specific point is consulted only when the result actually failed.
    const point = failed && (parsed.hooks.postToolUseFailure !== undefined) ? 'postToolUseFailure' : 'postToolUse'
    const merged = await runPoint(point, exec.name, {
      ...copilotToolPayload(exec),
      hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse',
      toolResult: result,
    }, {
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      cwd: exec.agent?.session?.header?.cwd,
      signal: exec.signal,
    })
    const context = joinedContext(merged.additionalContext)
    if (context !== undefined) return { kind: 'accept', additionalContexts: [context] }
    return next()
  })

  // ── Session lifecycle ──────────────────────────────────────────────────
  ctx.on('agent/created', async ({ agent, source, signal }) => {
    const merged = await runPoint('sessionStart', undefined, {
      sessionId: String(agent?.id ?? ''),
      timestamp: Date.now(),
      cwd: agent?.session?.header?.cwd ?? process.cwd(),
      hook_event_name: 'SessionStart',
      source,
    }, { agent, cwd: agent?.session?.header?.cwd, signal })
    await injectContext(agent, joinedContext(merged.additionalContext))
  })

  ctx.on('session/created', async (session) => {
    // Copilot's Setup-shaped hooks observe session creation separately from the
    // agent-start context channel.
    await runPoint('setup', undefined, {
      sessionId: String(session?.id ?? ''),
      cwd: session?.header?.cwd,
      hook_event_name: 'Setup',
    }, { cwd: session?.header?.cwd })
  })

  ctx.on('agent/disposed', async ({ agent }) => {
    await runPoint('sessionEnd', undefined, {
      sessionId: String(agent?.id ?? ''),
      cwd: agent?.session?.header?.cwd,
      hook_event_name: 'SessionEnd',
    }, { cwd: agent?.session?.header?.cwd })
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const prompt = (messages ?? [])
      .map((message) => message.content?.map((block) => block.text ?? '').join('') ?? '')
      .join('\n')
    const merged = await runPoint('userPromptSubmitted', prompt, {
      sessionId: String(agent?.id ?? ''),
      timestamp: Date.now(),
      cwd: agent?.session?.header?.cwd,
      prompt,
      hook_event_name: 'UserPromptSubmit',
      turn,
      step,
    }, { agent, cwd: agent?.session?.header?.cwd, signal })
    const downstream = await next()
    if (merged.decision === 'deny' || merged.decision === 'block') return { kind: 'reject' }
    const context = joinedContext(merged.additionalContext)
    if (context === undefined || downstream.kind !== 'enter') return downstream
    try {
      return {
        ...downstream,
        messages: [
          ...downstream.messages,
          (await peers()).createUserMessage({ content: [{ type: 'text', text: context }], source: { ...CONTEXT_SOURCE, form: 'notice', summary: 'Copilot prompt hook context' } }),
        ],
      }
    } catch {
      return downstream
    }
  })

  // ── Stop: force another turn through the next-step inbox ───────────────
  // Copilot caps consecutive blocks at 8 so a buggy unconditional hook cannot
  // spin the agent forever. The cap is part of the vendor contract, so the
  // bridge reproduces it rather than leaving the loop unbounded.
  const stopStreak = { turn: undefined, count: 0 }
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const merged = await runPoint('agentStop', undefined, {
      sessionId: String(agent?.id ?? ''),
      cwd: agent?.session?.header?.cwd,
      hook_event_name: 'Stop',
      turn,
      stop_hook_active: false,
    }, { agent, cwd: agent?.session?.header?.cwd, signal })
    // `mergeHookOutputs` folds Copilot's `decision:"block"` into the shared
    // `deny` rank (both mean "forbid"), so the stop path must accept `deny`.
    if (merged.decision !== 'block' && merged.decision !== 'deny') {
      stopStreak.count = 0
      return
    }
    if (merged.reason === undefined || merged.reason.trim() === '') {
      ctx.logger?.warn?.('hooks-copilot: agentStop asked to block without a reason; the turn ends (reason is required)')
      return
    }
    if (stopStreak.turn !== turn) {
      stopStreak.turn = turn
      stopStreak.count = 0
    }
    stopStreak.count += 1
    if (stopStreak.count > STOP_BLOCK_LIMIT) {
      ctx.logger?.warn?.(
        `hooks-copilot: agentStop exceeded ${STOP_BLOCK_LIMIT} consecutive blocks on turn ${turn}; allowing the turn to end (Copilot runaway guard).`,
      )
      return
    }
    try {
      const { createUserMessage } = await peers()
      agent?.inbox?.append?.('next-step', createUserMessage({
        content: [{ type: 'text', text: merged.reason }],
        source: { ...CONTEXT_SOURCE, form: 'notice', summary: 'Copilot stop hook continuation' },
      }))
    } catch (error) {
      ctx.logger?.warn?.(`hooks-copilot: cannot force another turn: ${String(error?.message ?? error)}`)
    }
  })

  // ── Subagents ──────────────────────────────────────────────────────────
  ctx.on('subagent/start', async (info) => {
    // `ctx.get` is used rather than the `ctx.agents` property: the bridge does
    // not declare `agents` in `inject`, and Cordis throws on an undeclared
    // property access even when the service is absent.
    const child = ctx.get('agents')?.get?.(info.id)
    const merged = await runPoint('subagentStart', undefined, {
      sessionId: String(info.id ?? ''),
      cwd: child?.session?.header?.cwd,
      hook_event_name: 'SubagentStart',
      agentId: String(info.id ?? ''),
      provider: info.provider,
    }, { agent: child, cwd: child?.session?.header?.cwd })
    await injectContext(child, joinedContext(merged.additionalContext))
  })

  ctx.on('subagent/end', async (info) => {
    await runPoint('subagentStop', undefined, {
      sessionId: String(info.id ?? ''),
      hook_event_name: 'SubagentStop',
      agentId: String(info.id ?? ''),
      stopReason: info.stopReason,
      response: Array.isArray(info.lastAssistantMessage)
        ? info.lastAssistantMessage.map((block) => block?.text ?? '').join('')
        : undefined,
    }, {})
  })

  // ── Errors, status, settings ───────────────────────────────────────────
  ctx.on('agent/error', async ({ agent, turn, step, error }) => {
    await runPoint('errorOccurred', undefined, {
      sessionId: String(agent?.id ?? ''),
      cwd: agent?.session?.header?.cwd,
      hook_event_name: 'ErrorOccurred',
      turn,
      step,
      error: {
        message: typeof error?.message === 'string' ? error.message : String(error),
        name: typeof error?.name === 'string' ? error.name : 'Error',
      },
    }, { cwd: agent?.session?.header?.cwd })
  })

  ctx.on('agent/status', async (payload) => {
    await runPoint('notification', undefined, {
      sessionId: String(payload.agent?.id ?? ''),
      cwd: payload.agent?.session?.header?.cwd,
      hook_event_name: 'Notification',
      notification_type: payload.status,
    }, { cwd: payload.agent?.session?.header?.cwd })
  })

  ctx.on('settings/document-updated', async (ns, revision) => {
    await runPoint('configChange', undefined, {
      hook_event_name: 'ConfigChange',
      namespace: String(ns ?? ''),
      revision,
    }, {})
  })
}
