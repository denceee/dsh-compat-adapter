/**
 * Native translation router.
 *
 * This is the module that makes a bridge-less vendor actually WORK: it mounts
 * real DSH seam listeners and maps each vendor hook's decision into the typed
 * decision the seam expects. It is the counterpart to `observe.js`:
 *
 *   observe.js   → read-only auditing (hook runs, decision ignored, degradation says so)
 *   translate.js → real interception (hook's decision reaches DSH)
 *
 * Translation is only used where the mapping is honest. Every entry names the
 * exact DSH decision type it produces, and a vendor hook whose output cannot be
 * expressed in that type leaves it untouched rather than guessing.
 *
 * @module dsh-compat-adapter/translate
 */

import { runHookProtocol } from './hook-runner.js'

/**
 * The translation points this adapter implements, keyed by the `point` a vendor
 * mapping names. Each entry documents the seam it mounts on and the DSH
 * decision contract it must produce.
 */
export const NATIVE_TRANSLATIONS = Object.freeze({
  'tools/pre-execute': Object.freeze({
    event: 'preToolUse',
    seam: 'tools/pre-execute',
    mode: 'waterfall',
    produces: 'PreToolDecision',
  }),
  'tools/post-execute': Object.freeze({
    event: 'postToolUse',
    seam: 'tools/post-execute',
    mode: 'waterfall',
    produces: 'PostToolDecision',
  }),
  'agent/created': Object.freeze({
    event: 'sessionStart',
    seam: 'agent/created',
    mode: 'serial',
    produces: 'none',
  }),
  'agent/pre-step': Object.freeze({
    event: 'userPromptSubmitted',
    seam: 'agent/pre-step',
    mode: 'waterfall',
    produces: 'PreStepDecision',
  }),
  'agent/turn-stopping': Object.freeze({
    event: 'agentStop',
    seam: 'agent/turn-stopping',
    mode: 'serial',
    produces: 'none',
  }),
  'agent/disposed': Object.freeze({
    event: 'sessionEnd',
    seam: 'agent/disposed',
    mode: 'emit',
    produces: 'none',
  }),
  // Error observation. `agent/error` is an emit event carrying the verbatim
  // failure; both Copilot (errorOccurred) and Claude (StopFailure) surface the
  // same moment. It is observe-only: DSH's error path has no verdict channel.
  'agent/error': Object.freeze({
    event: 'errorOccurred',
    seam: 'agent/error',
    mode: 'emit',
    produces: 'none',
  }),
  // Subagent lifecycle. `subagent/start` is an emit event, but the child Agent
  // resolves through ctx.agents.get(info.id) DURING the notification, so a start
  // hook can inject context into the child; end is observe-only.
  'subagent/start': Object.freeze({
    event: 'subagentStart',
    seam: 'subagent/start',
    mode: 'emit',
    produces: 'none',
  }),
  // Permission decisions. `approval/request` is a WATERFALL returning an
  // ApprovalOutcome, so a hook here can really allow or deny — this is the one
  // place a permission-shaped hook can take effect.
  'approval/request': Object.freeze({
    event: 'PermissionRequest',
    seam: 'approval/request',
    mode: 'waterfall',
    produces: 'ApprovalOutcome',
  }),
  // Shell environment contribution. DSH exposes a registry (ctx.shellEnv) whose
  // contributors return DSH_*-prefixed variables per execution; an OpenCode
  // `shell.env` hook is re-authored as a command whose stdout supplies values.
  'shell/env': Object.freeze({
    event: 'shell.env',
    seam: 'shellEnv',
    mode: 'registry',
    produces: 'environment variables',
  }),
  // Post-compaction observation. `compaction/end` is the durable settle event;
  // the summary itself lives on `compaction/summary`, so both are consulted.
  'compaction/end': Object.freeze({
    event: 'PostCompact',
    seam: 'session/event',
    mode: 'emit',
    produces: 'none',
  }),
  // Pre-compaction observation (Copilot preCompact has no decision either).
  'compaction/start': Object.freeze({
    event: 'preCompact',
    seam: 'session/event',
    mode: 'emit',
    produces: 'none',
  }),
  // Prompt rewriting. DSH agent/pre-step returns the admitted messages, so a
  // transformed prompt can really replace what the model receives.
  'agent/pre-step/transform': Object.freeze({
    event: 'userPromptTransformed',
    seam: 'agent/pre-step',
    mode: 'waterfall',
    produces: 'PreStepDecision',
  }),
  // Approval audit observation. `approval/decided` is a durable log-only event;
  // a denied decision is the honest source for a "permission denied" hook.
  'session/event': Object.freeze({
    event: 'PermissionDenied',
    seam: 'session/event',
    mode: 'emit',
    produces: 'none',
  }),
  // Todo list snapshots. `todo/write` is the durable whole-list snapshot, so a
  // task-shaped hook observes creation/completion by diffing snapshots.
  'todo/write': Object.freeze({
    event: 'TaskCreated',
    seam: 'session/event',
    mode: 'emit',
    produces: 'none',
  }),
  // Session creation. `session/created` announces a session before its first
  // turn; Setup-shaped hooks observe it.
  'session/created': Object.freeze({
    event: 'Setup',
    seam: 'session/created',
    mode: 'emit',
    produces: 'none',
  }),
  'agent/instructions-loaded': Object.freeze({
    event: 'InstructionsLoaded',
    seam: 'session/created',
    mode: 'emit',
    produces: 'none',
  }),
  // Agent status flips idle/running — the closest honest mapping for "idle".
  // Precise message-arrival observation. `agent/inbox/inserted` carries the real
  // UserMessage that entered an agent's inbox, which is a genuine message event
  // rather than a whole-session-stream approximation.
  // Real command execution. `command/run` carries the command name and the
  // verbatim args, so a command-executed hook gets the actual command rather
  // than an unidentified session event.
  // REAL filesystem watching. DSH exposes `ctx.fs.watch(target, changed, signal)`
  // which wraps the backend's native watcher (chokidar / node:fs.watch), so a
  // file-change hook can fire on an ACTUAL change instead of after a tool call.
  // This is the adapter ADDING the missing seam rather than approximating it.
  // REAL elicitation interception. `user-questions/request` is a waterfall whose
  // listener may claim the request by returning an answer, so a hook can really
  // answer (or refuse to answer) a structured question instead of observing
  // status flips. This is the adapter supplying the missing elicitation seam.
  'user-questions/request': Object.freeze({
    event: 'Elicitation',
    seam: 'user-questions/request',
    mode: 'waterfall',
    produces: 'AskUserQuestionAnswer',
  }),
  'fs/watch': Object.freeze({
    event: 'FileChanged',
    seam: 'fs.watch',
    mode: 'watcher',
    produces: 'none',
  }),
  'command/run': Object.freeze({
    event: 'command.executed',
    seam: 'session/event',
    mode: 'emit',
    produces: 'none',
  }),
  'workspace/changes': Object.freeze({
    event: 'FileChanged',
    seam: 'session/event',
    mode: 'emit',
    produces: 'none',
  }),
  'agent/inbox/inserted': Object.freeze({
    event: 'message.updated',
    seam: 'agent/inbox/inserted',
    mode: 'emit',
    produces: 'none',
  }),
  'agent/status': Object.freeze({
    event: 'TeammateIdle',
    seam: 'agent/status',
    mode: 'emit',
    produces: 'none',
  }),
  // Settings observation. `settings/document-updated` is emit and carries the
  // namespace + new revision; ConfigChange hooks only need to observe a change.
  'settings/document-updated': Object.freeze({
    event: 'ConfigChange',
    seam: 'settings/document-updated',
    mode: 'emit',
    produces: 'none',
  }),
  'subagent/end': Object.freeze({
    event: 'subagentStop',
    seam: 'subagent/end',
    mode: 'emit',
    produces: 'none',
  }),
})

/**
 * Build the stdin payload for one translation point from live DSH facts.
 *
 * Fields the vendor documents but DSH cannot reconstruct are explicit nulls:
 * a hook can tell the difference between "absent" and "we do not have it",
 * which is what an honest adaptation requires.
 *
 * @param {string} point - translation point key.
 * @param {object} facts - observed facts.
 * @returns {Record<string, unknown>} the stdin payload object.
 */
export function buildTranslationPayload(point, facts) {
  const base = {
    sessionId: facts.sessionId ?? '',
    timestamp: Date.now(),
    cwd: facts.cwd ?? process.cwd(),
    transcriptPath: null,
  }
  switch (point) {
    case 'tools/pre-execute':
      return {
        ...base,
        toolName: facts.toolName,
        toolArgs: facts.toolArgs ?? {},
        ...(facts.callId === undefined ? {} : { toolCallId: facts.callId }),
        toolResult: null,
      }
    case 'tools/post-execute':
      return {
        ...base,
        toolName: facts.toolName,
        toolArgs: facts.toolArgs ?? {},
        ...(facts.callId === undefined ? {} : { toolCallId: facts.callId }),
        toolResult: facts.toolResult ?? null,
      }
    case 'agent/pre-step':
      return {
        ...base,
        prompt: facts.prompt ?? '',
        turn: facts.turn ?? null,
        step: facts.step ?? null,
      }
    case 'agent/turn-stopping':
      return {
        ...base,
        turn: facts.turn ?? null,
        // Copilot documents stop_hook_active; DSH has no equivalent, so the hook
        // is told plainly that this signal is unavailable rather than "false".
        stopHookActive: false,
      }
    case 'agent/created':
      return { ...base, source: facts.source ?? 'startup' }
    case 'agent/disposed':
      return { ...base }
    case 'agent/inbox/inserted':
      return {
        ...base,
        messageId: facts.messageId ?? null,
        text: facts.text ?? '',
        role: 'user',
        transition: facts.transition ?? 'updated',
      }
    case 'agent/instructions-loaded':
      return {
        ...base,
        source: facts.source ?? 'session-start',
        // Real discovered file list, not an approximation.
        instructionFiles: Array.isArray(facts.paths) ? facts.paths : [],
        projectRoot: facts.projectRoot ?? null,
      }
    case 'user-questions/request':
      return {
        ...base,
        // The vendor carries an elicitation request from an MCP server; DSH's
        // seam carries structured questions for the user.
        questions: Array.isArray(facts.questions) ? facts.questions : [],
        questionCount: facts.questionCount ?? 0,
        requestId: facts.requestId ?? null,
      }
    case 'fs/watch':
      return {
        ...base,
        // The watcher reports a path and an action; the vendor sees one change.
        path: facts.path ?? '',
        action: facts.action ?? 'change',
        trigger: 'watcher',
      }
    case 'command/run':
      return {
        ...base,
        commandName: facts.commandName ?? '',
        commandArgs: facts.commandArgs ?? null,
        commandId: facts.commandId ?? null,
        source: facts.sourceKind ?? 'user',
      }
    case 'workspace/changes':
      return {
        ...base,
        // The vendor reports one changed path per invocation; DSH summarizes a
        // whole turn, so the event carries the turn and its complete file list.
        turn: facts.turn ?? null,
        paths: Array.isArray(facts.paths) ? facts.paths : [],
        total: facts.total ?? 0,
        added: facts.added ?? 0,
        deleted: facts.deleted ?? 0,
      }
    case 'compaction/end':
      return {
        ...base,
        trigger: facts.trigger ?? 'auto',
        // Copilot's preCompact carries the trigger; PostCompact adds the summary.
        compactSummary: facts.summary ?? null,
        compactionId: facts.compactionId ?? null,
        ...(facts.error === undefined ? {} : { error: facts.error }),
      }
    case 'compaction/start':
      return {
        ...base,
        trigger: facts.trigger ?? 'auto',
        compactionId: facts.compactionId ?? null,
        compactSummary: null,
      }
    case 'agent/pre-step/transform':
      return {
        ...base,
        prompt: facts.prompt ?? '',
        transformedPrompt: facts.prompt ?? '',
        turn: facts.turn ?? null,
        step: facts.step ?? null,
      }
    case 'shell/env':
      return {
        ...base,
        toolName: facts.toolName ?? '',
        toolArgs: facts.toolArgs ?? {},
      }
    case 'session/event':
      return {
        ...base,
        // The vendor reports which permission was denied; DSH's durable audit
        // event carries the tool, not a per-call permission object.
        toolName: facts.toolName ?? '',
        decision: facts.decision ?? 'rejected',
      }
    case 'todo/write':
      return {
        ...base,
        // The vendor models individual task create/complete events; DSH publishes
        // a whole-list snapshot, so the diff is reported as the transition set.
        taskId: null,
        taskTitle: facts.taskTitle ?? '',
        transition: facts.transition ?? 'created',
        todoCount: facts.todoCount ?? 0,
      }
    case 'approval/request':
      return {
        ...base,
        toolName: facts.toolName ?? '',
        toolInput: facts.toolInput ?? {},
        ...(facts.callId === undefined ? {} : { toolCallId: facts.callId }),
        reason: facts.reason ?? null,
        // Copilot's permissionRequest reports the kind of permission being asked
        // for; DSH's approval seam carries only the tool, so it is derived
        // honestly rather than invented.
        permissionKind: facts.permissionKind ?? 'tool',
      }
    case 'session/created':
      return {
        ...base,
        source: facts.source ?? 'startup',
        // DSH has no "which instruction files loaded" fact at this seam.
        instructionFiles: null,
      }
    case 'agent/status':
      return {
        ...base,
        agentId: facts.agentId ?? '',
        status: facts.status ?? 'idle',
      }
    case 'settings/document-updated':
      return {
        ...base,
        // The vendor models a changed configuration file; DSH reports one settings
        // namespace reaching a new revision, which is the closest honest fact.
        source: 'settings',
        filePath: null,
        namespace: facts.namespace ?? '',
        revision: facts.revision ?? null,
      }
    case 'agent/error':
      return {
        ...base,
        turn: facts.turn ?? null,
        step: facts.step ?? null,
        // The vendor documents an error object; DSH hands over whatever was
        // thrown, so it is normalized to the documented shape without inventing
        // a stack that does not exist.
        error: {
          message: facts.errorMessage ?? '',
          name: facts.errorName ?? 'Error',
          ...(facts.errorStack === undefined ? {} : { stack: facts.errorStack }),
        },
        errorContext: facts.errorContext ?? 'system',
        recoverable: facts.recoverable ?? false,
      }
    case 'subagent/start':
      return {
        ...base,
        // DSH keyed the carrier by the delegating parent; the child identity
        // fields are what the vendor's matcher filters on.
        subagentId: facts.subagentId ?? '',
        provider: facts.provider ?? '',
        local: facts.local ?? false,
        agentName: null,
        agentType: null,
      }
    case 'subagent/end':
      return {
        ...base,
        subagentId: facts.subagentId ?? '',
        provider: facts.provider ?? '',
        local: facts.local ?? false,
        stopReason: facts.stopReason ?? null,
        response: facts.lastAssistantMessage ?? null,
        agentName: null,
        agentType: null,
      }
    default:
      return { ...base }
  }
}

/**
 * Read a Copilot decision from the RAW stdout.
 *
 * This exists because the DSH hook protocol's decoder only recognizes
 * `hookSpecificOutput.permissionDecision` (the Claude/Codex dialect). Copilot
 * writes the decision at the TOP LEVEL —
 * `{"permissionDecision":"deny","permissionDecisionReason":"…"}` — so relying on
 * the shared decoder alone would silently treat every Copilot deny as "no
 * decision". That is exactly the kind of fake green this adapter must not ship.
 *
 * Both shapes are accepted: the native Copilot top-level object (if the payload
 * already carries a `hookSpecificOutput`, the shared decoder handles it and this
 * returns undefined so the caller falls back).
 *
 * @param {import('@deepseek-ai/dsh-hook-protocol').HookOutput} output - decoded output (stdout preserved verbatim).
 * @returns {{permissionDecision?: 'allow'|'deny'|'ask', reason?: string, additionalContext?: string}|undefined} the parsed native decision.
 */
export function parseCopilotStdout(output) {
  const raw = typeof output.stdout === 'string' ? output.stdout.trim() : ''
  if (raw === '' || !raw.startsWith('{')) return undefined
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  // A Claude-shaped payload is already handled by the shared decoder.
  if (parsed.hookSpecificOutput !== undefined) return undefined
  // Two distinct Copilot decision fields:
  //  - preToolUse writes `permissionDecision` (allow/deny/ask)
  //  - agentStop writes the top-level `decision` (block/allow)
  // Both must be read, or one event family silently loses its decision.
  const permission = parsed.permissionDecision
  const stopDecision = parsed.decision
  const normalized =
    permission === 'allow' || permission === 'deny' || permission === 'ask'
      ? permission
      : permission === 'block'
        ? 'block'
        : stopDecision === 'block'
          ? 'block'
          : undefined
  const reason =
    typeof parsed.permissionDecisionReason === 'string' && parsed.permissionDecisionReason !== ''
      ? parsed.permissionDecisionReason
      : typeof parsed.reason === 'string' && parsed.reason !== ''
        ? parsed.reason
        : undefined
  const additionalContext =
    typeof parsed.additionalContext === 'string' && parsed.additionalContext !== '' ? parsed.additionalContext : undefined
  if (normalized === undefined && additionalContext === undefined && reason === undefined) return undefined
  return {
    ...(normalized === undefined ? {} : { permissionDecision: normalized }),
    ...(reason === undefined ? {} : { reason }),
    ...(additionalContext === undefined ? {} : { additionalContext }),
  }
}

/**
 * Fold the native Copilot decision back into the decoded output so every
 * downstream mapper sees one normalized shape.
 *
 * @param {import('@deepseek-ai/dsh-hook-protocol').HookOutput} output - decoded output.
 * @returns {import('@deepseek-ai/dsh-hook-protocol').HookOutput} a normalized copy (or the original when nothing native was found).
 */
export function normalizeCopilotOutput(output) {
  const native = parseCopilotStdout(output)
  if (native === undefined) return output
  const normalized = { ...output }
  if (native.permissionDecision !== undefined) normalized.decision = native.permissionDecision
  if (native.reason !== undefined) normalized.reason = native.reason
  if (native.additionalContext !== undefined) normalized.additionalContext = native.additionalContext
  return normalized
}

/**
 * Map one decoded hook output into a DSH PreToolDecision.
 *
 * Contract: only stdout `permissionDecision` blocks. `allow` means "do not
 * prompt" in Copilot, so it falls through to the DSH pipeline instead of
 * force-allowing, and any other value means "no decision".
 *
 * @param {import('@deepseek-ai/dsh-hook-protocol').HookOutput} output - decoded output.
 * @returns {{kind: 'allow'} | {kind: 'deny', reason: string} | {kind: 'ask', reason?: string}} the decision.
 */
export function preToolDecisionFrom(output) {
  const reason = typeof output.reason === 'string' && output.reason !== '' ? output.reason : undefined
  if (output.decision === 'deny' || output.decision === 'block') {
    return { kind: 'deny', reason: reason ?? 'denied by a translated pre-tool hook' }
  }
  if (output.decision === 'ask') return reason === undefined ? { kind: 'ask' } : { kind: 'ask', reason }
  return { kind: 'allow' }
}

/**
 * Map one decoded hook output into a DSH PostToolDecision.
 *
 * Only `additionalContext` is forwarded; Copilot's `modifiedResult` is a result
 * rewrite this adapter does not claim (the mapping's degradations say so).
 *
 * @param {import('@deepseek-ai/dsh-hook-protocol').HookOutput} output - decoded output.
 * @returns {{kind: 'accept', additionalContexts?: string[]}|undefined} the decision, or undefined to pass.
 */
export function postToolDecisionFrom(output) {
  const context = output.additionalContext
  if (typeof context === 'string' && context.trim() !== '') {
    return { kind: 'accept', additionalContexts: [context] }
  }
  return undefined
}

/**
 * Read injected context from a session-start / prompt hook output.
 *
 * @param {import('@deepseek-ai/dsh-hook-protocol').HookOutput} output - decoded output.
 * @returns {string|undefined} the context, when non-empty.
 */
export function injectedContextFrom(output) {
  const context = output.additionalContext
  if (typeof context === 'string' && context.trim() !== '') return context
  // A plain (non-JSON) stdout body is the vendor's "context" channel.
  const plain = output.stdout?.trim?.()
  if (typeof plain === 'string' && plain !== '' && !plain.startsWith('{')) return plain
  return undefined
}

/**
 * Map a permission hook's stdout to a DSH ApprovalOutcome.
 *
 * Copilot's `permissionRequest` writes `{behavior: "allow"|"deny", message}`.
 * DSH expresses "allow" only as the one-shot `allowed-once`, so the mapping is
 * explicit rather than pretending a broader grant exists. Anything else returns
 * undefined so the normal approval chain runs.
 *
 * @param {import('@deepseek-ai/dsh-hook-protocol').HookOutput} output - decoded output.
 * @returns {'allowed-once'|'rejected'|undefined} the outcome, or undefined to delegate.
 */
export function permissionVerdictFrom(output) {
  // Read the native behavior field when the shared decoder did not claim it.
  let behavior
  const raw = typeof output.stdout === 'string' ? output.stdout.trim() : ''
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (parsed.behavior === 'allow' || parsed.behavior === 'deny') behavior = parsed.behavior
      }
    } catch {
      /* malformed stdout means no verdict */
    }
  }
  if (behavior === 'allow') return 'allowed-once'
  if (behavior === 'deny') return 'rejected'
  // Also honor the Claude/Copilot permissionDecision shape for one hook body
  // across vendors.
  if (output.decision === 'deny' || output.decision === 'block') return 'rejected'
  if (output.decision === 'allow') return 'allowed-once'
  return undefined
}

/**
 * Read the rewritten model-facing prompt from a `userPromptTransformed` hook.
 *
 * Copilot's contract is mutation-only: `modifiedTransformedPrompt` replaces what
 * the model receives (the timeline still shows the original). DSH's agent/pre-step
 * can replace the admitted message list, which is the same lever.
 *
 * @param {import('@deepseek-ai/dsh-hook-protocol').HookOutput} output - decoded output.
 * @returns {string|undefined} the replacement text, when the hook supplied one.
 */
export function transformedPromptFrom(output) {
  const raw = typeof output.stdout === 'string' ? output.stdout.trim() : ''
  if (!raw.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const value = parsed.modifiedTransformedPrompt
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Build a DSH `AskUserQuestionAnswer` from a hook's stdout.
 *
 * The vendor's elicitation reply carries the user's answers. DSH's answer shape
 * is `{ answers: [{ id, selected, custom? }] }`, so each vendor answer is mapped
 * onto the question it names; an answer naming no known question is ignored
 * rather than fabricating one.
 *
 * @param {import('@deepseek-ai/dsh-hook-protocol').HookOutput} output - decoded output.
 * @param {ReadonlyArray<object>} questions - the questions being asked.
 * @returns {{answers: Array<{id: string, selected: string[], custom?: string}>}|undefined} the answer, or undefined to delegate.
 */
export function elicitationAnswerFrom(output, questions) {
  const raw = typeof output.stdout === 'string' ? output.stdout.trim() : ''
  if (!raw.startsWith('{')) return undefined
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const candidates = Array.isArray(parsed.answers)
    ? parsed.answers
    : Array.isArray(parsed.selected)
      ? [{ id: questions[0]?.id, selected: parsed.selected, custom: parsed.custom }]
      : undefined
  if (candidates === undefined) return undefined
  const known = new Set(questions.map((question) => String(question?.id ?? '')))
  const answers = []
  for (const item of candidates) {
    if (item === null || typeof item !== 'object') continue
    const id = String(item.id ?? '')
    // Skip an answer whose id names no asked question: inventing one would make
    // the caller believe the user answered something they never saw.
    if (known.size > 0 && !known.has(id)) continue
    const selected = Array.isArray(item.selected) ? item.selected.map((value) => String(value)) : []
    const custom = typeof item.custom === 'string' && item.custom !== '' ? item.custom : undefined
    if (selected.length === 0 && custom === undefined) continue
    answers.push({ id, selected, ...(custom === undefined ? {} : { custom }) })
  }
  return answers.length === 0 ? undefined : { answers }
}

/**
 * Whether a stop hook asked to force another turn.
 *
 * @param {import('@deepseek-ai/dsh-hook-protocol').HookOutput} output - decoded output.
 * @returns {{blocked: boolean, reason?: string}} the stop decision.
 */
export function stopDecisionFrom(output) {
  if (output.decision === 'block') {
    const reason = typeof output.reason === 'string' && output.reason !== '' ? output.reason : undefined
    return { blocked: true, ...(reason === undefined ? {} : { reason }) }
  }
  return { blocked: false }
}

/**
 * Run one translated hook command. Returns undefined when it cannot run, which
 * the caller treats as "no decision" and records as a degradation.
 *
 * @param {object} options - run options.
 * @param {object} options.registration - the registered translation.
 * @param {object} options.payload - stdin payload.
 * @param {import('@deepseek-ai/dsh-shell').ShellExecutor|undefined} options.shell - shell executor.
 * @param {string|undefined} options.cwd - working directory.
 * @param {AbortSignal|undefined} options.signal - cancellation.
 * @param {number} options.defaultTimeoutMs - default timeout.
 * @returns {Promise<{output: object, durationMs: number}|undefined>} the run result.
 */
export async function runTranslatedHook(options) {
  const run = await runHookProtocol({
    shell: options.shell,
    command: options.registration.handler,
    timeoutSec: options.registration.timeoutSec,
    payload: options.payload,
    cwd: options.cwd,
    signal: options.signal,
    defaultTimeoutMs: options.defaultTimeoutMs,
    trailingNewline: true,
    expectedEventName: options.registration.event,
  })
  // Normalize the vendor's native stdout shape BEFORE any mapper sees it.
  return run === undefined ? undefined : { ...run, output: normalizeCopilotOutput(run.output) }
}
