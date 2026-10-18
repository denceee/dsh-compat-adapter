/**
 * WorkBuddy vendor adapter.
 *
 * Truthful scope statement: Tencent's WorkBuddy desktop app has **no public
 * hook API**. The publicly documented hook surface belongs to the CodeBuddy
 * engine that WorkBuddy shares (CodeBuddy IDE / CodeBuddy CLI docs). Those
 * docs state the hook mechanism is "fully compatible with the Claude Code
 * Hooks specification" with a smaller IDE event set, so this adapter treats a
 * `vendor: 'workbuddy'` declaration as a CodeBuddy-compatible hook config and
 * routes it through the shipped Claude Code bridge, with the documented
 * divergences listed as degradations on each event.
 *
 * Divergences that matter (and are never silently ignored):
 * - `CLAUDE_PROJECT_DIR` vs `CODEBUDDY_PROJECT_DIR` in command substitution /
 *   environment: the Claude bridge exports the former only.
 * - CodeBuddy reports `modifiedInput` where Claude Code reports
 *   `updatedInput`; the CC bridge's `updatedInput` handling does not apply, and
 *   neither is honored by DSH anyway.
 * - The desktop app's own project instructions (entered in the UI) are
 *   cloud-side and are NOT files this adapter can read; only the CodeBuddy
 *   rules files are carryable.
 *
 * @module dsh-compat-adapter/vendors/workbuddy
 */

import { freezeHookTable, bridged, nativeTranslate, unsupported } from './shared.js'

/** Bridge used for WorkBuddy: its documented hook shape is CC-compatible. */
export const BRIDGE_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code'

/** Normalized vendor key. */
export const VENDOR = 'workbuddy'

/**
 * WorkBuddy / CodeBuddy rules artifacts. Official docs place project rules at
 * `.codebuddy/rules/`, `.codebuddy/CODEBUDDY.md` and `AGENTS.md`, with
 * project > user precedence. They are instruction text (context), not policy.
 */
export const RULES = Object.freeze({
  capability: 'CARRY',
  formats: Object.freeze(['markdown']),
  defaultSources: Object.freeze(['.codebuddy/CODEBUDDY.md', '.codebuddy/rules/**/*.md', 'CODEBUDDY.md', 'AGENTS.md']),
  note: 'Carried verbatim and injected as a sourced user message at session start. WorkBuddy desktop project instructions entered in the UI are cloud-side and cannot be carried; only on-disk CodeBuddy rules files are read.',
})

/** Degradations that apply to EVERY bridged WorkBuddy event. */
const WORKBUDDY_BRIDGE_DEGRADATIONS = Object.freeze([
  'WorkBuddy desktop has no public hook API; this declaration is interpreted as a CodeBuddy-engine hook config, which Tencent documents as Claude-Code-compatible.',
  'CODEBUDDY_PROJECT_DIR is not exported; command substitution and hook environment only receive CLAUDE_PROJECT_DIR.',
  'CodeBuddy `modifiedInput` is not read (the Claude bridge only parses `updatedInput`, which is itself not honored by DSH).',
])

/**
 * Per-event mapping. The working baseline is the CodeBuddy IDE's seven-event
 * hook set (SessionStart, SessionEnd, PreToolUse, PostToolUse,
 * UserPromptSubmit, Stop, PreCompact); the CLI's larger event list is not
 * bridged, so those names are UNSUPPORTED here even where the CLI documents
 * them.
 */
export const HOOKS = freezeHookTable(VENDOR, {
  SessionStart: bridged({
    bridge: 'claude',
    seams: ['agent/created'],
    degradations: [
      ...WORKBUDDY_BRIDGE_DEGRADATIONS,
      'Runs detached; context can miss the first request.',
    ],
  }),
  UserPromptSubmit: bridged({
    bridge: 'claude',
    seams: ['agent/pre-step'],
    degradations: [...WORKBUDDY_BRIDGE_DEGRADATIONS, 'Deny is honored; plain-stdout context is not promoted.'],
  }),
  PreToolUse: bridged({
    bridge: 'claude',
    seams: ['tools/pre-execute'],
    degradations: [
      ...WORKBUDDY_BRIDGE_DEGRADATIONS,
      'Matcher semantics differ: CodeBuddy matches a case-sensitive regex against the tool name, while the Claude bridge uses its literal-or-regex rule, so a pattern like `edit` may match fewer tools than in WorkBuddy.',
      'Only deny/ask decisions are honored; modifiedInput is not.',
    ],
    note: 'Blocking contract: stdout hookSpecificOutput.permissionDecision deny/ask with exit code 0.',
  }),
  PostToolUse: bridged({
    bridge: 'claude',
    seams: ['tools/post-execute'],
    degradations: [...WORKBUDDY_BRIDGE_DEGRADATIONS, 'Output rewriting is not honored; tool_response is flattened to text.'],
  }),
  Stop: bridged({
    bridge: 'claude',
    seams: ['agent/turn-stopping'],
    degradations: [...WORKBUDDY_BRIDGE_DEGRADATIONS, 'No consecutive-block cap; stop_hook_active is always false.'],
  }),
  SessionEnd: nativeTranslate({
    point: 'agent/disposed',
    seams: ['agent/disposed'],
    degradations: [
      'Runs through this adapter’s own native mapping, not the Claude bridge (the bridge does not implement SessionEnd).',
      'DSH agent/disposed fires whenever an Agent leaves the registry (reload, teardown), broader than a session end.',
      'Observe-only: no decision output is honored.',
    ],
  }),
  PreCompact: nativeTranslate({
    point: 'compaction/start',
    seams: ['session/event'],
    degradations: [
      'Runs through this adapter’s own native mapping, not the Claude bridge.',
      'Observe-only: DSH compaction is a service call, not a cancellable waterfall, so the hook cannot veto compaction.',
    ],
  }),

  // CodeBuddy CLI documents a larger list; none of it is bridged.
  PostToolUseFailure: nativeTranslate({
    point: 'tools/post-execute',
    seams: ['tools/post-execute'],
    degradations: [
      'Documented by CodeBuddy CLI only and not bridged; this adapter mounts the observation itself.',
      'DSH reports successes and failures through one waterfall, so this fires only when the result is marked as an error.',
    ],
  }),
  SubagentStart: nativeTranslate({
    point: 'subagent/start',
    seams: ['subagent/start'],
    degradations: [
      'Documented by CodeBuddy CLI only and not bridged; this adapter mounts its own observation.',
      'The agent-type label is absent from DSH’s seam, so a matcher on agent type cannot narrow.',
    ],
  }),
  SubagentStop: nativeTranslate({
    point: 'subagent/end',
    seams: ['subagent/end'],
    degradations: [
      'Documented by CodeBuddy CLI only and not bridged; this adapter mounts its own observation.',
      'Observe-only: the child has already settled.',
    ],
  }),
  StopFailure: nativeTranslate({
    point: 'agent/error',
    seams: ['agent/error'],
    degradations: [
      'Documented by CodeBuddy CLI only; this adapter mounts its own observation on DSH agent errors.',
      'Observe-only: DSH exposes no verdict channel on its error path.',
    ],
  }),
  PermissionDenied: nativeTranslate({
    point: 'session/event',
    seams: ['session/event'],
    degradations: [
      'Observe-only: driven by the durable `approval/decided` audit event after the decision committed.',
      'Only `rejected` outcomes fire it.',
    ],
  }),
  TaskCreated: nativeTranslate({
    point: 'todo/write',
    seams: ['session/event'],
    degradations: [
      'Observe-only: derived by diffing whole todo-list snapshots, not from a create event.',
      'Only todo-style tasks are visible.',
    ],
  }),
  TaskCompleted: nativeTranslate({
    point: 'todo/write',
    seams: ['session/event'],
    degradations: [
      'Observe-only: derived when a todo item\'s status becomes `completed` in a snapshot.',
      'A task removed without completing does not fire it.',
    ],
  }),
  TeammateIdle: nativeTranslate({
    point: 'agent/status',
    seams: ['agent/status'],
    degradations: [
      'Observe-only: fires for any agent entering `idle`, not only team members.',
    ],
  }),
  FileChanged: nativeTranslate({
    point: 'tools/post-execute',
    seams: ['tools/post-execute'],
    degradations: [
      'Approximate: fires after a tool call that could have changed files, not when a file actually changes.',
      'External edits do not fire it.',
    ],
  }),
  CwdChanged: nativeTranslate({
    point: 'session/created',
    seams: ['session/created'],
    degradations: [
      'Observational approximation: DSH pins the session cwd at creation and never changes it, so this fires once with the initial cwd.',
    ],
  }),
  WorktreeCreate: nativeTranslate({
    point: 'session/created',
    seams: ['session/created'],
    degradations: [
      'Approximate: DSH has no worktree lifecycle, so this fires at session creation without worktree details.',
    ],
  }),
  WorktreeRemove: nativeTranslate({
    point: 'agent/disposed',
    seams: ['agent/disposed'],
    degradations: [
      'Approximate: fires when the agent leaves the registry; the payload carries no worktree path.',
    ],
  }),
  Setup: nativeTranslate({
    point: 'session/created',
    seams: ['session/created'],
    degradations: [
      'Observe-only: DSH announces session creation after the harness is running.',
    ],
  }),
  InstructionsLoaded: nativeTranslate({
    point: 'session/created',
    seams: ['session/created'],
    degradations: [
      'Observe-only and coarser: reports session creation, not which files loaded (`instructionFiles` is null).',
    ],
  }),
  ConfigChange: nativeTranslate({
    point: 'settings/document-updated',
    seams: ['settings/document-updated'],
    degradations: [
      'Documented by CodeBuddy CLI only; this adapter mounts its own observation on DSH settings updates.',
      'Observe-only and namespace-scoped: no file path is reported, so a matcher on a config path never narrows.',
    ],
  }),
  Elicitation: nativeTranslate({
    point: 'agent/status',
    seams: ['agent/status'],
    degradations: [
      'Observe-only and approximate: DSH has no MCP elicitation seam, so this reports agent status flips rather than an elicitation request.',
      'The hook cannot answer or block the elicitation.',
    ],
  }),
  ElicitationResult: nativeTranslate({
    point: 'agent/status',
    seams: ['agent/status'],
    degradations: [
      'Observe-only and approximate: no DSH event carries an elicitation result; this reports the following status flip.',
    ],
  }),
})

/** Every event name this adapter knows about for this vendor (supported or not). */
export const KNOWN_EVENTS = Object.freeze(Object.keys(HOOKS))

/**
 * WorkBuddy's non-file surfaces are explicitly out of scope. Exposed so the
 * service can answer `registerRuntime({vendor:'workbuddy'})` with the precise
 * reason instead of a vague refusal.
 */
export const RULES_UI_NOTE =
  'WorkBuddy desktop project instructions are entered in the app UI and stored cloud-side; they are not readable files and cannot be carried or injected by this adapter.'
