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
    point: 'session/event',
    seams: ['session/event'],
    degradations: [
      'Approximate: DSH has no slash-command hook seam, so this observes the durable session event stream and cannot identify the command.',
      'The callback body is not carried: the hook is a command invoked per logged event.',
    ],
  }),
  'file.edited': nativeTranslate({
    point: 'tools/post-execute',
    seams: ['tools/post-execute'],
    degradations: [
      'Approximate: fires after a tool call that could have written files, not when a file is actually edited.',
      'External edits outside DSH tool calls do not fire it.',
    ],
  }),
  'file.watcher.updated': nativeTranslate({
    point: 'tools/post-execute',
    seams: ['tools/post-execute'],
    degradations: [
      'Approximate: DSH has no file-watch contract, so this observes tool completion rather than watcher events.',
      'A matcher on a path cannot narrow: the payload carries the tool call, not a watched path.',
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
    point: 'tools/post-execute',
    seams: ['tools/post-execute'],
    degradations: [
      'Approximate: DSH has no LSP diagnostics seam, so this observes tool completion instead.',
      'No diagnostic payload is available to the hook.',
    ],
  }),
  'lsp.updated': nativeTranslate({
    point: 'tools/post-execute',
    seams: ['tools/post-execute'],
    degradations: ['Approximate: no DSH LSP seam exists; this fires on tool completion.'],
  }),
  'message.part.removed': nativeTranslate({
    point: 'session/event',
    seams: ['session/event'],
    degradations: ['Approximate: observes the durable session event stream; DSH publishes no part-level removal hook.'],
  }),
  'message.part.updated': nativeTranslate({
    point: 'session/event',
    seams: ['session/event'],
    degradations: ['Approximate: observes the durable session event stream rather than part updates.'],
  }),
  'message.removed': nativeTranslate({
    point: 'session/event',
    seams: ['session/event'],
    degradations: ['Approximate: DSH message removal is a surface operation with no hook point.'],
  }),
  'message.updated': nativeTranslate({
    point: 'session/event',
    seams: ['session/event'],
    degradations: ['Approximate: observes the durable event stream; each logged message event fires it.'],
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
    point: 'tools/post-execute',
    seams: ['tools/post-execute'],
    degradations: ['Approximate: DSH records workspace changes per session rather than publishing a diff event; this observes tool completion.'],
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
    point: 'agent/pre-step',
    seams: ['agent/pre-step'],
    degradations: [
      'Approximate: DSH has no TUI seam; this observes the assembled prompt at the step boundary.',
      'The hook cannot write into the TUI input.',
    ],
  }),
  'tui.command.execute': nativeTranslate({
    point: 'session/event',
    seams: ['session/event'],
    degradations: ['Approximate: no DSH TUI command seam; observes the durable event stream.'],
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
