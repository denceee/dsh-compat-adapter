/**
 * Claude Code vendor adapter.
 *
 * Claude Code's command-hook subset is already bridged by the shipped
 * `@deepseek-ai/dsh-hooks-claude-code`; this adapter does NOT re-implement that
 * bridge. It declares, for each Claude Code hook event, whether the shipped
 * bridge covers it and at which fidelity, so a preset author can see the
 * answer at authoring time and `registerHook` can route the declaration into
 * the bridge's config instead of guessing.
 *
 * Coverage baseline: `dsh-hooks-claude-code@0.2.0-rc.2` supports
 * SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart,
 * SubagentStop. Everything else in the reference surface is UNSUPPORTED by the
 * bridge; a few of those have independent native Host seams, which are marked
 * as native-seam ADAPTED only where the translation is honest (PreCompact,
 * SessionEnd) — otherwise UNSUPPORTED with the exact reason.
 *
 * @module dsh-compat-adapter/vendors/claude
 */

import { freezeHookTable, bridged, nativeSeam, nativeTranslate, unsupported } from './shared.js'

/** Official bridge package this vendor's hooks are routed into. */
export const BRIDGE_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code'

/** Normalized vendor key. */
export const VENDOR = 'claude'

/**
 * Claude Code rules artifacts: instruction markdown, concatenated by the
 * reference tool and explicitly documented as guidance rather than
 * enforcement. Carrying the text and injecting it as a sourced user message
 * preserves exactly those semantics; the adapter never turns rules into tool
 * policy.
 */
export const RULES = Object.freeze({
  capability: 'CARRY',
  formats: Object.freeze(['markdown', 'claude-rules-frontmatter']),
  defaultSources: Object.freeze(['CLAUDE.md', '.claude/rules/*.md', '~/.claude/CLAUDE.md']),
  note: 'Carried verbatim and injected as a sourced user message at session start. Claude treats rules as context, not enforced configuration; this adapter preserves that precisely and never turns them into tool policy.',
})

/**
 * Per-event mapping. Keys are the reference event names (the official
 * reference lists 36 events; the ones absent here are not part of the subset
 * this adapter claims knowledge of and are treated as UNKNOWN_EVENT by
 * `registerHook`).
 */
export const HOOKS = freezeHookTable(VENDOR, {
  SessionStart: bridged({
    bridge: 'claude',
    seams: ['agent/created'],
    degradations: [
      'Runs detached through the bridge, so context can miss the model first request.',
      'Plain-stdout context, initialUserMessage, sessionTitle, watchPaths and CLAUDE_ENV_FILE are not consumed.',
      'Payload omits model, agent_type and session_title.',
    ],
  }),
  UserPromptSubmit: bridged({
    bridge: 'claude',
    seams: ['agent/pre-step'],
    degradations: [
      'Deny is honored; plain-stdout context, sessionTitle and suppressOriginalPrompt are not.',
      'Unless the hook sets its own timeout the bridge uses its 600s default, not the reference 30s.',
    ],
  }),
  PreToolUse: bridged({
    bridge: 'claude',
    seams: ['tools/pre-execute'],
    degradations: [
      'deny and ask are honored; allow does not pre-approve and defer is unsupported.',
      'updatedInput is parsed and warned about but not honored.',
      'additionalContext from a PreToolUse hook is ignored.',
    ],
    note: 'Blocking contract: stdout hookSpecificOutput.permissionDecision deny/ask with exit code 0. Never rely on exit code 2.',
  }),
  PostToolUse: bridged({
    bridge: 'claude',
    seams: ['tools/post-execute'],
    degradations: [
      'Blocking feedback and additionalContext work; updatedToolOutput and updatedMCPToolOutput do not.',
      'tool_response is flattened to text.',
    ],
  }),
  Stop: bridged({
    bridge: 'claude',
    seams: ['agent/turn-stopping'],
    degradations: [
      'A blocking Stop forces another step, but stop_hook_active is always false and last_assistant_message is omitted.',
      'There is no consecutive-block cap; an unconditional blocking hook keeps forcing turns.',
    ],
  }),
  SubagentStart: bridged({
    bridge: 'claude',
    seams: ['subagent/start'],
    degradations: [
      'agent_type is the constant general-purpose; a matcher naming a specific agent type never fires.',
      'Injected context can only reach an in-process child.',
    ],
  }),
  SubagentStop: bridged({
    bridge: 'claude',
    seams: ['subagent/end'],
    degradations: [
      'Observe-only: cannot block the child or feed it context.',
      'agent_transcript_path, last_assistant_message, background_tasks and session_crons are omitted.',
    ],
  }),

  // ── Events with no bridge coverage but an honest native-seam translation ──

  PostCompact: nativeTranslate({
    point: 'compaction/end',
    seams: ['session/event'],
    degradations: [
      'Observe-only: the compaction already completed, so a hook can react but never change the result.',
      'The summary is taken from the preceding durable `compaction/summary` event; the hook sees the same text, not a live object.',
      '`trigger` is reported as "auto" because DSH does not distinguish a manual /compact from automatic pressure at this seam.',
    ],
  }),
  PreCompact: nativeSeam({
    point: 'compaction/start',
    seams: ['session/event'],
    degradations: [
      'Cannot veto compaction: DSH compaction is a service call, not a cancellable waterfall, so the hook is observe-only.',
      'Fires on the durable compaction/start event after compaction was requested, not before the summary is computed.',
      'A blocking decision (deny / exit 2) is audited but does NOT prevent compaction.',
    ],
    note: 'Use this for telemetry/notifications. Preventing compaction requires owning the compaction service, which this adapter does not do.',
  }),
  SessionEnd: nativeSeam({
    point: 'agent/disposed',
    seams: ['agent/disposed'],
    degradations: [
      'agent/disposed fires when an Agent leaves the live registry, which is broader than the reference end-of-session moment (dispose also happens on reload/teardown).',
      'Payload carries no reason and no transcript path; anything the hook needs must be read from the session working directory.',
    ],
  }),

  // ── Events the bridge ignores and DSH has no faithful seam for ──

  Setup: nativeTranslate({
    point: 'session/created',
    seams: ['session/created'],
    degradations: [
      'Observe-only: DSH announces a created session but exposes no pre-activation configuration channel here.',
      'Fires when a Session object is created, which is after the harness is already running — not before hooks are enabled as the reference tool does.',
    ],
  }),
  InstructionsLoaded: nativeTranslate({
    point: 'agent/instructions-loaded',
    seams: ['session/created'],
    degradations: [
      'Fires once per created session with the full discovered list, not once per file as the reference event does.',
      'The list is what DSH discovery would find (CLAUDE.md, AGENTS.md, configured candidates); a file added later is not re-reported.',
      'Observe-only: DSH loads instructions through dsh-agent-instructions, which exposes no veto or rewrite here.',
    ],
  }),
  UserPromptExpansion: nativeTranslate({
    point: 'agent/pre-step',
    seams: ['agent/pre-step'],
    degradations: [
      'Observe-only: DSH pre-step receives the already-assembled batch, so the hook cannot rewrite the expansion.',
      'Fires per step, not once per expanded prompt.',
    ],
  }),
  MessageDisplay: nativeTranslate({
    point: 'session/event',
    seams: ['session/event'],
    degradations: [
      'Observe-only and approximate: DSH has no display seam, so this reports the durable message event that would be displayed.',
      'The hook cannot alter, delay, or suppress presentation.',
    ],
  }),
  PermissionRequest: nativeTranslate({
    point: 'approval/request',
    seams: ['approval/request'],
    degradations: [
      'Decisions map onto DSH ApprovalOutcome: allow→`allowed-once`, deny→`rejected`. DSH has no broader grant, so a hook cannot express "always allow".',
      'The approval waterfall only runs when DSH actually asks for approval; a tool the preset already permits never reaches this hook.',
      'The reference payload’s permission-mode detail is absent; DSH reports the tool and its reason only.',
    ],
  }),
  PermissionDenied: nativeTranslate({
    point: 'session/event',
    seams: ['session/event'],
    degradations: [
      'Observe-only: the decision already committed, so the hook cannot change it.',
      'Driven by the durable `approval/decided` audit event with outcome `rejected`; other outcomes do not fire it.',
    ],
  }),
  PostToolUseFailure: nativeTranslate({
    point: 'tools/post-execute',
    seams: ['tools/post-execute'],
    degradations: [
      'Mounted by this adapter rather than the shipped bridge (the bridge does not map this event).',
      'Only fires when the result is marked as an error; DSH uses one waterfall for successes and failures.',
    ],
  }),
  PostToolBatch: nativeTranslate({
    point: 'tools/post-execute',
    seams: ['tools/post-execute'],
    degradations: [
      'Approximate: DSH dispatches tools individually and has no batch seam, so this fires per completed tool call rather than once per batch.',
      'The hook receives one tool result, not a batch summary.',
    ],
  }),
  Notification: nativeTranslate({
    point: 'agent/status',
    seams: ['agent/status'],
    degradations: [
      'Observe-only and coarse: DSH publishes agent status flips, not typed notifications.',
      '`matcher` cannot narrow because DSH carries no notification type.',
    ],
  }),
  TaskCreated: nativeTranslate({
    point: 'todo/write',
    seams: ['session/event'],
    degradations: [
      'Observe-only: DSH publishes a whole todo-list snapshot, so creation is derived by diffing snapshots.',
      'Only todo-style tasks are visible; jobs and team tasks register through services with no event.',
    ],
  }),
  TaskCompleted: nativeTranslate({
    point: 'todo/write',
    seams: ['session/event'],
    degradations: [
      'Observe-only: completion is derived from a todo snapshot where an item\'s status became `completed`.',
      'A task removed from the list without being completed does not fire it.',
    ],
  }),
  StopFailure: nativeTranslate({
    point: 'agent/error',
    seams: ['agent/error'],
    degradations: [
      'Observe-only: DSH exposes no verdict channel on its error path, so this hook can report but never retry or alter the failure.',
      'Fires for any turn/step agent error, not only the "API error ended the turn" moment the reference tool reports.',
      'Reference payload fields (error type, retryability) are approximated from the thrown error and are not normalized to Claude’s vocabulary.',
    ],
  }),
  TeammateIdle: nativeTranslate({
    point: 'agent/status',
    seams: ['agent/status'],
    degradations: [
      'Observe-only: DSH status flips are a consequence of driver activity, so a hook cannot make an agent idle.',
      'Fires for any agent entering `idle`, not only teammates in a team.',
    ],
  }),
  ConfigChange: nativeTranslate({
    point: 'settings/document-updated',
    seams: ['settings/document-updated'],
    degradations: [
      'Observe-only: the new settings revision has already committed, so a hook cannot block or rewrite it.',
      'DSH reports settings namespaces, not the configuration FILES the reference tool watches; `filePath` is null and a matcher on a path never narrows.',
    ],
  }),
  CwdChanged: nativeTranslate({
    point: 'session/created',
    seams: ['session/created'],
    degradations: [
      'Observational approximation: DSH pins the session working directory at creation and never changes it, so this fires once at session creation with the initial cwd instead of on a change.',
    ],
  }),
  DirectoryAdded: nativeTranslate({
    point: 'session/created',
    seams: ['session/created'],
    degradations: [
      'Observational approximation: DSH grants one working directory per session and has no directory-addition event, so this fires once at session creation.',
    ],
  }),
  FileChanged: nativeTranslate({
    point: 'fs/watch',
    seams: ['fs.watch'],
    degradations: [
      'This adapter ARMS a real filesystem watcher (ctx.fs.watch) on the session working directory, so external edits fire it — not only DSH-made changes.',
      'One watcher covers the session cwd with depth 0, matching the reference tool\'s project-directory watch; a change deep inside a subtree may not be reported by every backend.',
      'Bursts are coalesced with a 250ms debounce, so several rapid edits report as one change.',
      'A composition without ctx.fs falls back to the turn-summary approximation, and the reason is logged.',
    ],
  }),
  WorktreeCreate: nativeTranslate({
    point: 'session/created',
    seams: ['session/created'],
    degradations: [
      'Approximate: DSH has no worktree lifecycle, so this fires at session creation — the moment an isolated worktree would be prepared — without any worktree information in the payload.',
    ],
  }),
  WorktreeRemove: nativeTranslate({
    point: 'agent/disposed',
    seams: ['agent/disposed'],
    degradations: [
      'Approximate: DSH has no worktree lifecycle, so this fires when the agent leaves the registry — the moment a worktree would be cleaned up.',
      'The payload carries no worktree path.',
    ],
  }),
  PreModelSwitch: nativeTranslate({
    point: 'session/created',
    seams: ['session/created'],
    degradations: [
      'Approximate: DSH has no pre-switch waterfall, so this cannot run before a switch; it fires at session creation when the initial model is bound.',
      'It does not observe later model changes.',
    ],
  }),
  PostModelSwitch: nativeTranslate({
    point: 'session/event',
    seams: ['session/event'],
    degradations: [
      'Approximate: DSH publishes model binding through the durable `request/header` event, so this fires on header changes rather than on a dedicated switch event.',
    ],
  }),
  Elicitation: nativeTranslate({
    point: 'agent/status',
    seams: ['agent/status'],
    degradations: [
      'Approximate and observe-only: DSH has no MCP elicitation seam, so this reports agent status flips while a question is pending rather than the elicitation itself.',
      'The hook cannot answer or block it.',
    ],
  }),
  ElicitationResult: nativeTranslate({
    point: 'agent/status',
    seams: ['agent/status'],
    degradations: [
      'Approximate and observe-only: no DSH event carries an elicitation result, so this reports the status flip that follows the answer.',
    ],
  }),
})

/** Every event name this adapter knows about for this vendor (supported or not). */
export const KNOWN_EVENTS = Object.freeze(Object.keys(HOOKS))
