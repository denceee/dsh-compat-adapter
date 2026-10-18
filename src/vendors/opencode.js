/**
 * OpenCode vendor adapter.
 *
 * OpenCode's extension mechanism is a TypeScript plugin module whose hooks are
 * JS callbacks co-resident with OpenCode (`tool.execute.before`, `tool.execute.after`,
 * `event`, `shell.env`, …), not a JSON hook config executed as a subprocess.
 * This adapter therefore cannot carry OpenCode's callback BODIES; what it can do
 * is give each callback NAME a faithful DSH seam and run the author's command in
 * place of the in-process callback. That is the honest middle ground, and every
 * entry below states exactly which half is native and which half is re-authored.
 *
 * What it does NOT do: execute third-party TypeScript inside the DSH Host. A
 * callback that depends on OpenCode's in-process SDK objects (`client`, `$`,
 * `project`) cannot be carried; the author must express the same intent as a
 * command/HTTP hook.
 *
 * @module dsh-compat-adapter/vendors/opencode
 */

import { freezeHookTable, nativeTranslate } from './shared.js'

/** OpenCode has no official bridge: none of its hooks route through a bridge. */
export const BRIDGE_PACKAGE = null

/** Normalized vendor key. */
export const VENDOR = 'opencode'

/**
 * OpenCode rules artifacts: `AGENTS.md` plus the config `instructions` array
 * (globs and remote URLs). All instruction text.
 */
export const RULES = Object.freeze({
  capability: 'CARRY',
  formats: Object.freeze(['markdown']),
  defaultSources: Object.freeze(['AGENTS.md', '~/.config/opencode/AGENTS.md']),
  note: 'Carried verbatim and injected as a sourced user message at session start. Remote URLs in the OpenCode `instructions` array are NOT fetched: this adapter does not make network requests, so a remote instruction source must be materialized to a local file first.',
})

/**
 * Per-event table. Every entry is UNSUPPORTED, with the exact reason; the
 * table exists so `registerHook` can answer precisely and so the support
 * matrix is honest about names a preset author might try.
 */
export const HOOKS = freezeHookTable(VENDOR, {
  'tool.execute.before': nativeTranslate({
    point: 'tools/pre-execute',
    seams: ['tools/pre-execute'],
    degradations: [
      'OpenCode blocks by THROWING inside an in-process callback; there is no stdout/exit contract. This adapter runs the author’s command instead, so the hook body must be re-authored as a command rather than carried verbatim.',
      'A deny maps onto DSH tools/pre-execute; OpenCode has no `ask` equivalent here, so a command that wants confirmation must say so in its reason.',
      'The callback’s in-process SDK arguments (client, $, project) are not available to a command hook.',
    ],
  }),
  'tool.execute.after': nativeTranslate({
    point: 'tools/post-execute',
    seams: ['tools/post-execute'],
    degradations: [
      'The in-process callback body is not carried; the hook must be a command that reads the tool result from stdin.',
      'Only `additionalContext` is forwarded back; OpenCode callbacks could mutate native result objects directly.',
    ],
  }),
  event: nativeTranslate({
    point: 'session/event',
    seams: ['session/event'],
    degradations: [
      'OpenCode’s event bus has no serializable contract; this maps the DURABLE session event stream instead, so only events DSH logs are observable.',
      'The callback body is not carried: the hook is a command invoked per logged event.',
    ],
  }),
  'shell.env': nativeTranslate({
    point: 'shell/env',
    seams: ['shellEnv'],
    degradations: [
      'DSH’s shell environment registry only exposes variables under the `DSH_` prefix, so an OpenCode hook that sets arbitrary environment variables can only contribute `DSH_*` ones.',
      'The registry is rebuilt per model shell call, not per OpenCode shell invocation.',
      'The callback body is not carried: the hook is a command whose stdout becomes the variable values.',
    ],
  }),
  permission: nativeTranslate({
    point: 'approval/request',
    seams: ['approval/request'],
    degradations: [
      'OpenCode’s `permission` config is a policy table, not a hook; this maps a COMMAND declaration onto the approval waterfall, so the policy must be expressed as a script.',
      'Decisions map onto DSH ApprovalOutcome: allow→`allowed-once`, deny→`rejected`; there is no "always" grant.',
    ],
  }),

  // ── OpenCode event-bus names (28 in the official list) ─────────────────
  // Each maps onto the closest honest DSH seam. Most are observe-only; the
  // permission pair reaches the approval waterfall and can really decide.
  'command.executed': nativeTranslate({
    point: 'command/run',
    seams: ['session/event'],
    degradations: [
      'Fires when DSH commits a `command/run` record, which names the command and its verbatim args; the payload is richer than a bare event stream, but it is still not the OpenCode callback object.',
      'The callback body is not carried: the hook is a command invoked per logged command run.',
    ],
  }),
  'file.edited': nativeTranslate({
    point: 'fs/watch',
    seams: ['fs.watch'],
    degradations: [
      'This adapter arms a real filesystem watcher (ctx.fs.watch), so a genuine file edit fires it rather than a per-turn summary.',
      'The payload names the watched directory and the action, not the OpenCode editor object.',
    ],
  }),
  'file.watcher.updated': nativeTranslate({
    point: 'fs/watch',
    seams: ['fs.watch'],
    degradations: [
      'This adapter supplies the missing watcher seam itself via ctx.fs.watch; OpenCode\'s watcher-updated callback object is not carried.',
      'Bursts are coalesced with a 250ms debounce.',
    ],
  }),
  'installation.updated': nativeTranslate({
    point: 'settings/document-updated',
    seams: ['settings/document-updated'],
    degradations: [
      'Approximate: DSH reports settings namespaces reaching a new revision, not dependency installations.',
      'Observe-only: the change already committed.',
    ],
  }),
  'lsp.client.diagnostics': nativeTranslate({
    point: 'lsp/query',
    seams: ['lsp'],
    degradations: [
      'REAL language-server contact: queries the official `ctx.lsp` seam (install @deepseek-ai/dsh-lsp) after a turn\'s files change, so the hook receives an actual server result rather than a tool-completion guess.',
      'DSH\'s LSP seam deliberately EXCLUDES diagnostics: its four operations are goToDefinition / findReferences / goToImplementation / hover. This hook is therefore fed a hover query, never a diagnostics payload — a diagnostics-specific hook body cannot be satisfied faithfully.',
      'The seam is pull-only (no push notification), so the hook fires after changed files are known rather than when a server pushes diagnostics.',
      'A composition without ctx.lsp reports the absence instead of inventing a result.',
    ],
  }),
  'lsp.updated': nativeTranslate({
    point: 'lsp/query',
    seams: ['lsp'],
    degradations: [
      'REAL language-server contact through `ctx.lsp`; the pull seam is polled after a turn\'s changed files, which is the honest equivalent of "the server has something for these files now".',
      'No push notification exists in DSH, so timing differs from OpenCode\'s server-initiated update.',
      'Only the first changed files are queried (capped per turn); a large turn does not query every path.',
    ],
  }),
  'message.part.removed': nativeTranslate({
    point: 'agent/inbox/inserted',
    seams: ['agent/inbox/inserted'],
    degradations: [
      'DSH publishes no part-level removal event, so a message arrival is the closest honest trigger; the payload names the new message, not the removed part.',
    ],
  }),
  'message.part.updated': nativeTranslate({
    point: 'agent/inbox/inserted',
    seams: ['agent/inbox/inserted'],
    degradations: [
      'DSH publishes no part-level update event, so this fires when a message enters the inbox; the payload names the whole message, not one part.',
    ],
  }),
  'message.removed': nativeTranslate({
    point: 'agent/inbox/inserted',
    seams: ['agent/inbox/inserted'],
    degradations: [
      'DSH message removal is a surface operation with no hook point, so a message arrival is the closest trigger; the payload does not identify the removed message.',
    ],
  }),
  'message.updated': nativeTranslate({
    point: 'agent/inbox/inserted',
    seams: ['agent/inbox/inserted'],
    degradations: [
      'Fires when a message enters an agent inbox, which is the real message-arrival moment; in-place edits of an existing message are not observed.',
    ],
  }),
  'permission.asked': nativeTranslate({
    point: 'approval/request',
    seams: ['approval/request'],
    degradations: [
      'This one is a REAL interception: the hook can answer the pending permission.',
      'Decisions map onto DSH ApprovalOutcome: allow→`allowed-once`, deny→`rejected`; there is no "always" grant.',
    ],
  }),
  'permission.replied': nativeTranslate({
    point: 'session/event',
    seams: ['session/event'],
    degradations: ['Observe-only: driven by the durable `approval/decided` audit event after the decision committed.'],
  }),
  'server.connected': nativeTranslate({
    point: 'session/created',
    seams: ['session/created'],
    degradations: ['Approximate: DSH announces session creation, not a client server connection.'],
  }),
  'session.created': nativeTranslate({
    point: 'session/created',
    seams: ['session/created'],
    degradations: ['Observe-only: DSH announces the created session but exposes no veto here.'],
  }),
  'session.compacted': nativeTranslate({
    point: 'compaction/end',
    seams: ['session/event'],
    degradations: ['Observe-only: the compaction already completed; the summary comes from the durable `compaction/summary` event.'],
  }),
  'session.deleted': nativeTranslate({
    point: 'agent/disposed',
    seams: ['agent/disposed'],
    degradations: ['Approximate: DSH fires when an Agent leaves the registry (also on reload/teardown), broader than a deletion.'],
  }),
  'session.diff': nativeTranslate({
    point: 'workspace/changes',
    seams: ['session/event'],
    degradations: [
      'Fires once per completed turn with that turn\'s changed-file summary (paths, added/deleted counts) rather than a live diff stream.',
      'File contents diffs are not carried to the hook; only the changed-path list and line counts.',
    ],
  }),
  'session.error': nativeTranslate({
    point: 'agent/error',
    seams: ['agent/error'],
    degradations: [
      'Observe-only: DSH exposes no verdict channel on its error path.',
      'Only turn/step agent errors are observed; provider transport failures reach agent/request-error instead.',
    ],
  }),
  'session.idle': nativeTranslate({
    point: 'agent/status',
    seams: ['agent/status'],
    degradations: [
      'Observe-only: DSH status flips are a consequence of driver activity; a hook cannot make an agent idle.',
      'Fires for any agent entering `idle`.',
    ],
  }),
  'session.status': nativeTranslate({
    point: 'agent/status',
    seams: ['agent/status'],
    degradations: ['Observe-only: reports DSH status flips rather than OpenCode’s richer status payload.'],
  }),
  'session.updated': nativeTranslate({
    point: 'session/event',
    seams: ['session/event'],
    degradations: ['Approximate: observes the durable event stream rather than a session-metadata update.'],
  }),
  'tui.prompt.append': nativeTranslate({
    point: 'agent/inbox/inserted',
    seams: ['agent/inbox/inserted'],
    degradations: [
      'REAL observation of a message entering the agent inbox, which is exactly what "prompt append" means; the payload carries the message id and text.',
      'DSH has no TUI input widget, so the hook cannot write INTO the composer — it observes submission, not typing.',
    ],
  }),
  'tui.command.execute': nativeTranslate({
    point: 'command/run',
    seams: ['session/event'],
    degradations: [
      'REAL observation of a committed `command/run`, which is exactly a command being executed; the payload names the command and its verbatim args.',
      'DSH has no TUI layer, so this fires for any command run (keyboard, tool, or model-initiated) rather than only TUI-initiated ones.',
    ],
  }),
  'tui.toast.show': nativeTranslate({
    point: 'agent/status',
    seams: ['agent/status'],
    degradations: [
      'Approximate: DSH notifications are client-surface events with no Host hook seam, so this observes agent status.',
      'The hook cannot display or suppress a toast.',
    ],
  }),
})

/** Every event name this adapter knows about for this vendor. */
export const KNOWN_EVENTS = Object.freeze(Object.keys(HOOKS))

/**
 * The hard limit, stated once so the service, matrix and README reuse the same
 * wording: a callback's BODY is never carried. OpenCode hooks are TypeScript
 * closures over in-process SDK objects; this adapter supplies the seam and the
 * wire format, so the author must re-express the intent as a command hook.
 */
export const RUNTIME_NOTE =
  'OpenCode callback BODIES are not carried: they are TypeScript closures over in-process SDK objects (client, $, project). This adapter maps each callback NAME onto a DSH seam and runs the author’s command there; a callback that depends on the SDK must be rewritten as a command or native DSH plugin. Rules (AGENTS.md, instructions[]) are carried as text.'
