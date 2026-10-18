/**
 * OpenAI Codex vendor adapter.
 *
 * Codex's five executable command-hook points are bridged by the shipped
 * `@deepseek-ai/dsh-hooks-codex`; this adapter declares their fidelity and
 * routes registrations into that bridge. Codex also has seven more hook event
 * names in its current schema (PermissionRequest, PreCompact, PostCompact,
 * SessionEnd, Interrupt, and the subagent pair) that the shipped bridge does
 * not implement; those are graded individually.
 *
 * Codex `rules/*.rules` are NOT instructions: they are a Starlark command
 * execution policy controlling what may run outside the sandbox. DSH has no
 * equivalent rule DSL, and translating Starlark to DSH policy would be a
 * semantic invention, so rules are CARRY-only (verbatim text injected at
 * session start) and explicitly never enforced.
 *
 * @module dsh-compat-adapter/vendors/codex
 */

import { freezeHookTable, bridged, nativeSeam, nativeTranslate, unsupported } from './shared.js'

/** Official bridge package this vendor's hooks are routed into. */
export const BRIDGE_PACKAGE = '@deepseek-ai/dsh-hooks-codex'

/** Normalized vendor key. */
export const VENDOR = 'codex'

/**
 * Codex rules artifacts: Starlark command-policy files (`rules/*.rules`),
 * scanned at startup by the reference tool. The adapter carries them verbatim
 * and injects the text as context; it never pretends the policy is enforced.
 */
export const RULES = Object.freeze({
  capability: 'CARRY',
  formats: Object.freeze(['starlark']),
  defaultSources: Object.freeze(['rules/*.rules', '.codex/rules/*.rules', '~/.codex/rules/*.rules']),
  note: 'Carried verbatim and injected as a sourced user message at session start. Codex rules are a Starlark command-execution policy (allow / prompt / forbidden) for what may run outside the sandbox; DSH has no equivalent rule engine, so this adapter does NOT translate or enforce them. Treat the injected text as documentation for the model, never as a security boundary.',
})

/**
 * Per-event mapping. Codex event names come from its hooks schema
 * (`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
 * `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
 * `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`).
 */
export const HOOKS = freezeHookTable(VENDOR, {
  SessionStart: bridged({
    bridge: 'codex',
    seams: ['agent/created'],
    degradations: [
      'Runs detached, so context can miss the first request.',
      'Payload `transcript_path` is always null and no hook environment is injected.',
    ],
  }),
  UserPromptSubmit: bridged({
    bridge: 'codex',
    seams: ['agent/pre-step'],
    degradations: [
      'Deny is honored; plain stdout is promoted to additionalContext only for this event and SessionStart.',
      'Payload omits fields the reference provides that DSH cannot reconstruct (for example prompt ids).',
    ],
  }),
  PreToolUse: bridged({
    bridge: 'codex',
    seams: ['tools/pre-execute'],
    degradations: [
      'Only blocking decisions are honored: Codex `permissionDecision: "ask"` has no approval path and is not surfaced as an ask.',
      '`updatedInput` rewrites are not honored.',
      'tool_input is flattened to `{ command }` (or `{}`), so non-shell tool arguments are not faithfully exposed.',
    ],
    note: 'Blocking contract: stdout hookSpecificOutput.permissionDecision "deny" with exit code 0. Never rely on exit code 2.',
  }),
  PostToolUse: bridged({
    bridge: 'codex',
    seams: ['tools/post-execute'],
    degradations: [
      'Blocking feedback and additionalContext work; output rewriting does not.',
      '`tool_response` is flattened to text.',
    ],
  }),
  Stop: bridged({
    bridge: 'codex',
    seams: ['agent/turn-stopping'],
    degradations: [
      'A blocking Stop forces another step; stop_hook_active is always false and last_assistant_message is null.',
      'No consecutive-block cap exists.',
    ],
  }),

  // ── Event names Codex defines but the shipped bridge does not implement ──

  PermissionRequest: nativeTranslate({
    point: 'approval/request',
    seams: ['approval/request'],
    degradations: [
      'Not routed through the Codex bridge (it does not implement this event); this adapter mounts the approval waterfall itself.',
      'Decisions map onto DSH ApprovalOutcome: allow→`allowed-once`, deny→`rejected`; DSH has no "always allow".',
      'DSH raises the waterfall only when an approval is actually requested.',
    ],
  }),
  PreCompact: nativeSeam({
    point: 'compaction/start',
    seams: ['session/event'],
    degradations: [
      'Observe-only: cannot veto compaction (DSH compaction is a service call, not a cancellable waterfall).',
      'Fires on the durable compaction/start event.',
    ],
  }),
  PostCompact: nativeSeam({
    point: 'compaction/end',
    seams: ['session/event'],
    degradations: [
      'Fires on the durable compaction/end event; a failed compaction also ends the transaction and is reported as an error field.',
      'No payload parity with the reference event.',
    ],
  }),
  SessionEnd: nativeSeam({
    point: 'agent/disposed',
    seams: ['agent/disposed'],
    degradations: [
      'agent/disposed is broader than the reference session end (reload and teardown also dispose Agents).',
      'No reason or transcript path in the payload.',
    ],
  }),
  SubagentStart: nativeTranslate({
    point: 'subagent/start',
    seams: ['subagent/start'],
    degradations: [
      'Not routed through the Codex bridge (it does not implement this event); this adapter mounts the observation itself.',
      'Observe-only: DSH has no Codex-shaped context-injection channel at this seam for a bridge-less wiring, so a hook can log but its context is not injected.',
      'Codex payload fields describing the subagent kind are absent; DSH carries only provider/local identity.',
    ],
  }),
  SubagentStop: nativeTranslate({
    point: 'subagent/end',
    seams: ['subagent/end'],
    degradations: [
      'Not routed through the Codex bridge (it does not implement this event); this adapter mounts the observation itself.',
      'Observe-only: the child has already settled, so neither blocking nor response rewriting can reach it.',
    ],
  }),
  Interrupt: nativeTranslate({
    point: 'agent/status',
    seams: ['agent/status'],
    degradations: [
      'Observe-only and approximate: DSH publishes status flips, not an interrupt event; this fires when an agent returns to `idle`, which an interrupt causes but does not identify.',
      'The hook cannot cancel or delay the interruption.',
    ],
  }),
})

/** Every event name this adapter knows about for this vendor (supported or not). */
export const KNOWN_EVENTS = Object.freeze(Object.keys(HOOKS))
