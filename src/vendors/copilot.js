/**
 * GitHub Copilot vendor adapter.
 *
 * Unlike Claude Code and Codex, Copilot has **no shipped DSH bridge**, so every
 * hook here is either translated by this adapter onto a native Host seam or
 * refused. There is nothing to reuse and nothing to pretend: a Copilot hook
 * that this adapter does not translate is UNSUPPORTED with the reason.
 *
 * Source of truth: GitHub's "GitHub Copilot hooks reference"
 * (docs.github.com/en/copilot/reference/hooks-reference) plus the VS Code agent
 * hooks page, which states that the selected harness owns the hook lifecycle.
 * Facts that shape this table:
 *
 * - Config is JSON, `{ "version": 1, "hooks": { <event>: [entry, …] } }`, loaded
 *   from `.github/hooks/*.json`, `~/.copilot/hooks/*.json`, a `hooks` block in
 *   `.github/copilot/settings.json`, `~/.copilot/settings.json`, plugins, and
 *   (enterprise) policy files. This adapter reads DECLARATIONS, not files, so
 *   discovery stays the preset author's job.
 * - Command entries may use `bash` / `powershell` / `command` (or `exec`+`args`
 *   in the CLI). Copilot events are lowerCamelCase; PascalCase aliases exist
 *   only in the "VS Code compatible" input format.
 * - `preToolUse` decides via stdout
 *   `{permissionDecision: "allow"|"deny"|"ask", permissionDecisionReason}`.
 *   **Exit 2 also denies**, and any non-zero exit is fail-closed for
 *   `preToolUse` — the opposite of the Claude/Codex bridge contract this
 *   adapter otherwise standardizes on, so it is called out per event.
 * - `agentStop` blocks with `{decision:"block", reason}` and has a runaway
 *   guard (8 consecutive blocks).
 * - `postToolUse` may rewrite results (`modifiedResult`) and add context.
 * - Matchers are ALWAYS regular expressions anchored as `^(?:PATTERN)$`.
 *
 * @module dsh-compat-adapter/vendors/copilot
 */

import { freezeHookTable, nativeTranslate, unsupported } from './shared.js'

/**
 * Copilot has no official DSH bridge. Declared as `null` so the service and the
 * matrix never imply one exists.
 */
export const BRIDGE_PACKAGE = null

/** Normalized vendor key. */
export const VENDOR = 'copilot'

/**
 * Copilot instruction artifacts. All of it is text; none of it is policy.
 *
 * Copilot's instruction surfaces are `.github/copilot-instructions.md`,
 * `.github/instructions/**\/*.instructions.md` (path-scoped via frontmatter),
 * and a project-root `AGENTS.md`; user scope is `~/.copilot/`.
 */
export const RULES = Object.freeze({
  capability: 'CARRY',
  formats: Object.freeze(['markdown', 'copilot-instructions-frontmatter']),
  defaultSources: Object.freeze([
    '.github/copilot-instructions.md',
    '.github/instructions/*.instructions.md',
    'AGENTS.md',
    '~/.copilot/copilot-instructions.md',
  ]),
  note: 'Carried verbatim and injected as a sourced user message at session start. Copilot treats these files as instructions/context, not enforced configuration; this adapter preserves that and never turns them into tool policy. `applyTo` frontmatter is carried as text and is NOT interpreted as path scoping.',
})

/** Degradations shared by every Copilot event this adapter translates. */
const COPLOT_TRANSLATION_DEGRADATIONS = Object.freeze([
  'Translated directly by this adapter: DSH ships no Copilot bridge, so payloads, matcher anchoring and decision mapping are re-implemented here rather than reused.',
])

/**
 * Per-event table.
 *
 * Every entry is `native-translate` or `unsupported`: DSH ships no Copilot
 * bridge, so the six mappable events are translated by this adapter into REAL
 * interceptions (a deny becomes a PreToolDecision, context becomes a message),
 * not observe-only auditing.
 */
export const HOOKS = freezeHookTable(VENDOR, {
  preToolUse: nativeTranslate({
    point: 'tools/pre-execute',
    seams: ['tools/pre-execute'],
    degradations: [
      ...COPLOT_TRANSLATION_DEGRADATIONS,
      'Matcher is a regular expression anchored as `^(?:PATTERN)$` by Copilot; this adapter passes the pattern through DSH matcher handling, so an unanchored pattern matches more here than it would in Copilot.',
      '`modifiedArgs` (argument rewriting) is NOT honored; only allow/deny/ask are.',
      'Copilot tool names are lowercase (`bash`, `edit`, `create`, `view`, `grep`, `glob`, `web_fetch`, `task`, `ask_user`) and do not match DSH tool names one-to-one, so a matcher written for Copilot may select different tools.',
      'Copilot denies the tool on exit 2 and on ANY non-zero exit (fail-closed); this adapter honors deny only through stdout `permissionDecision`, so a hook that signals denial only by exit code will not block here.',
    ],
    note: 'Blocking contract for this adapter: stdout {"permissionDecision":"deny","permissionDecisionReason":"…"} with exit code 0. Copilot also accepts exit 2, but this adapter standardizes on the stdout decision so one hook body works across vendors.',
  }),
  postToolUse: nativeTranslate({
    point: 'tools/post-execute',
    seams: ['tools/post-execute'],
    degradations: [
      ...COPLOT_TRANSLATION_DEGRADATIONS,
      '`modifiedResult` (result rewriting) is NOT honored; only `additionalContext` is forwarded.',
      'Matcher regex is applied to tool names that differ from Copilot’s tool vocabulary.',
    ],
  }),
  postToolUseFailure: nativeTranslate({
    point: 'tools/post-execute',
    seams: ['tools/post-execute'],
    degradations: [
      ...COPLOT_TRANSLATION_DEGRADATIONS,
      'DSH reports successes and failures through one waterfall, so this hook fires only when the result is marked as an error.',
      'The reference event can inject retry guidance; DSH forwards `additionalContext` on the same path as a successful call.',
    ],
  }),
  sessionStart: nativeTranslate({
    point: 'agent/created',
    seams: ['agent/created'],
    degradations: [
      ...COPLOT_TRANSLATION_DEGRADATIONS,
      'Runs synchronously during agent creation, so it can delay the first turn; Copilot runs session hooks before the session is interactive.',
      'Copilot’s `additionalContext` is injected as a sourced user message; other sessionStart outputs are not consumed.',
      'Copilot prompt-type hooks (`type: "prompt"`) are not supported by this adapter (command hooks only).',
    ],
  }),
  sessionEnd: nativeTranslate({
    point: 'agent/disposed',
    seams: ['agent/disposed'],
    degradations: [
      ...COPLOT_TRANSLATION_DEGRADATIONS,
      'DSH `agent/disposed` fires whenever an Agent leaves the live registry (including reload and teardown), which is broader than Copilot’s end-of-session moment.',
      'Observe-only: Copilot sessionEnd has no decision output, and neither does this mapping.',
    ],
  }),
  userPromptSubmitted: nativeTranslate({
    point: 'agent/pre-step',
    seams: ['agent/pre-step'],
    degradations: [
      ...COPLOT_TRANSLATION_DEGRADATIONS,
      'DSH pre-step receives the already-assembled message batch; the hook cannot rewrite the prompt, only contribute context.',
      'Copilot can block the prompt from this hook; this adapter does not translate that into a DSH rejection.',
    ],
  }),
  agentStop: nativeTranslate({
    point: 'agent/turn-stopping',
    seams: ['agent/turn-stopping'],
    degradations: [
      ...COPLOT_TRANSLATION_DEGRADATIONS,
      '`decision:"block"` is honored by appending a next-step message during the serial `agent/turn-stopping` dispatch, which the agent loop re-checks before ending the turn. The 8-block runaway guard is reproduced, so behavior matches Copilot.',
      '`stop_hook_active` is always false: DSH does not expose whether this turn was already forced to continue, so a hook that self-limits on that flag cannot do so here.',
      'The forced turn is driven by a synthetic user message carrying the hook reason; Copilot instead reuses its own continuation path, so message provenance differs.',
    ],
  }),
  subagentStart: nativeTranslate({
    point: 'subagent/start',
    seams: ['subagent/start'],
    degradations: [
      ...COPLOT_TRANSLATION_DEGRADATIONS,
      'Context is injected by resolving the child through ctx.agents.get(runId) during the start notification; a provider whose child Agent is not yet visible (e.g. a remote provider) receives no context.',
      '`matcher` on agent name is NOT supported: DSH carries no agent-name label on this seam, so the field is absent from the payload and a matcher that filters by name never narrows anything.',
    ],
  }),
  subagentStop: nativeTranslate({
    point: 'subagent/end',
    seams: ['subagent/end'],
    degradations: [
      ...COPLOT_TRANSLATION_DEGRADATIONS,
      'Observe-only: the child has already settled, so `decision:"block"` cannot continue it and `modifiedResponse` cannot rewrite its result.',
      '`matcher` on agent name is NOT supported (no agent-name label on this seam).',
    ],
  }),
  errorOccurred: nativeTranslate({
    point: 'agent/error',
    seams: ['agent/error'],
    degradations: [
      ...COPLOT_TRANSLATION_DEGRADATIONS,
      'Observe-only: DSH exposes no verdict channel on its error path, so a hook cannot recover, retry, or alter the failure.',
      'Only turn/step-scoped agent errors are observed; provider transport failures reach `agent/request-error` instead and service-level errors are not events at all.',
      '`errorContext` is reported as "system" unless the failure is known to be model- or tool-related, because DSH does not classify errors the way Copilot does.',
    ],
  }),
  notification: nativeTranslate({
    point: 'agent/status',
    seams: ['agent/status'],
    degradations: [
      ...COPLOT_TRANSLATION_DEGRADATIONS,
      'Observe-only and coarse: DSH publishes agent status flips, not the typed notification kinds Copilot defines.',
      '`matcher` on notification_type cannot narrow because DSH carries no notification type.',
    ],
  }),
  permissionRequest: nativeTranslate({
    point: 'approval/request',
    seams: ['approval/request'],
    degradations: [
      ...COPLOT_TRANSLATION_DEGRADATIONS,
      'Decisions map onto DSH ApprovalOutcome: allow→`allowed-once`, deny→`rejected`; DSH has no "always allow" grant.',
      'DSH raises this waterfall only when an approval is actually requested; pre-approved tools never reach the hook.',
      '`interrupt: true` (stop the agent on deny) has no DSH equivalent and is ignored.',
    ],
  }),
})

/** Every event name this adapter knows about for this vendor (supported or not). */
export const KNOWN_EVENTS = Object.freeze(Object.keys(HOOKS))
