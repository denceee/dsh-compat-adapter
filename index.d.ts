/**
 * Type declarations for `dsh-compat-adapter`.
 *
 * A consumer (another DSH plugin) does not import this module for its runtime
 * values: it declares `inject: ['compatAdapter']` and uses the service. These
 * types exist so that consumer gets editor completion and compile-time checking
 * for the declaration shapes and the graded results.
 *
 * @module dsh-compat-adapter
 */

/** The four capability grades. There is deliberately no boolean `supported`. */
export type Capability = 'DIRECT' | 'ADAPTED' | 'CARRY' | 'UNSUPPORTED'

/** Vendors this adapter knows how to declare. */
export type Vendor = 'claude' | 'codex' | 'workbuddy' | 'opencode' | 'copilot'

/** Accepted vendor spellings (canonical name plus documented aliases). */
export type VendorAlias =
  | Vendor
  | 'claude-code'
  | 'cc'
  | 'openai-codex'
  | 'codebuddy'
  | 'github-copilot'

/** How a supported asset reaches DSH. */
export type Route =
  /** Handed to the shipped official bridge for that dialect. */
  | 'official-bridge'
  /** Observed on a native seam; the hook cannot veto. */
  | 'native-seam'
  /** Translated by this adapter into a real interception. */
  | 'native-translate'

/** One command hook declaration accepted by `registerHook`. */
export interface CommandHandlerObject {
  /** Handler family. Only `command` can cross the declaration boundary. */
  type?: 'command'
  /** Shell command line to run. */
  command: string
  /** Per-hook timeout, seconds. */
  timeoutSec?: number
}

/** The frozen, graded result every registration returns. */
export interface CapabilityResult {
  /** Stable registration id (`<vendor>:<event>:<n>` by default). */
  readonly id: string
  /** Canonical vendor key. */
  readonly vendor: Vendor
  /** Asset family. */
  readonly asset: 'hook' | 'rules' | 'runtime'
  /** The grade. Never a boolean. */
  readonly capability: Capability
  /** The vendor hook event name (hooks only). */
  readonly event?: string
  /** DSH seams the asset programs against. */
  readonly seams: readonly string[]
  /**
   * Semantic losses, required for `ADAPTED`. Read this before assuming the port
   * is faithful — it is the whole point of the grading.
   */
  readonly degradations: readonly string[]
  /** Why the asset is unsupported; required for `UNSUPPORTED`. */
  readonly reason?: string
  /** Human-facing note carried through from the vendor table. */
  readonly note?: string
}

/** One hook declaration. */
export interface HookDeclaration {
  /** Declared vendor. Vendors are never guessed from file names. */
  vendor: VendorAlias
  /** The vendor's hook event name, e.g. `PreToolUse`, `preToolUse`, `agentStop`. */
  event: string
  /** Vendor matcher pattern. Copilot patterns are anchored regexes. */
  matcher?: string
  /**
   * A shell command (string or `{ type: 'command', command }`). A JS function
   * handler is graded `UNSUPPORTED`: this adapter does not execute foreign code
   * inside the DSH Host.
   */
  handler?: string | CommandHandlerObject
  /** Stable id; defaults to `<vendor>:<event>:<n>`. */
  id?: string
}

/** One rules declaration. */
export interface RulesDeclaration {
  /** Declared vendor. */
  vendor: VendorAlias
  /**
   * Absolute path, `baseDir`-relative path, `file://` URL, or glob. A source
   * that matches nothing is an authoring error, not an empty rule set.
   */
  source: string | readonly string[]
  /** Absolute base directory for relative sources. */
  baseDir?: string
  /** Stable id; defaults to `<vendor>:rules:<n>`. */
  id?: string
}

/** One vendor's entry in the static capability matrix. */
export interface VendorMatrix {
  readonly vendor: Vendor
  /** Official bridge package, or `null` when this adapter translates natively. */
  readonly bridgePackage: string | null
  readonly hooks: readonly {
    readonly vendor: Vendor
    readonly event: string
    readonly capability: Capability
    readonly route: Route
    readonly seams: readonly string[]
    readonly degradations: readonly string[]
    readonly bridge?: string
    readonly point?: string
    readonly reason?: string
    readonly note?: string
  }[][number][]
  /** Count of executable (`ADAPTED`) events. */
  readonly supported: number
  /** Count of refused events. */
  readonly unsupported: number
  readonly rules: {
    readonly capability: Capability
    readonly formats: readonly string[]
    readonly note: string
  }
  readonly runtime: { readonly capability: Capability; readonly reason: string }
}

/** Live state reported by `status()`. */
export interface AdapterStatus {
  /** DSH version this build targets. */
  readonly dshVersion: string
  /** Runtime DSH version the preset targets. */
  readonly targetDshVersion: string
  readonly disposed: boolean
  readonly vendors: readonly Vendor[]
  /** Which optional services this composition actually mounts. */
  readonly surface: { readonly shell: boolean; readonly sessionProjections: boolean }
  readonly hooks: readonly {
    readonly id: string
    readonly vendor: string
    readonly event: string
    readonly capability: Capability
    readonly seams: readonly string[]
    readonly bridge?: string
    readonly observationPoint?: string
  }[]
  readonly rules: readonly {
    readonly id: string
    readonly vendor: string
    readonly capability: Capability
    readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[]
  }[]
  readonly counts: {
    readonly hooks: number
    readonly executableHooks: number
    readonly unsupportedHooks: number
    readonly rules: number
    readonly carriedFiles: number
  }
}

/** Plugin config accepted through the Loader row. */
export interface Config {
  /** DSH version this plugin was authored against. */
  targetDshVersion?: string
  /** Emit one structured log line per graded registration. */
  logRegistrations?: boolean
  /** Refuse hook registrations whose required surface is missing. */
  failClosed?: boolean
  /** Per-file cap for carried rules text, in bytes. */
  maxRuleBytes?: number
}

/**
 * The service this plugin provides as `ctx.compatAdapter`.
 *
 * Declare `inject: ['compatAdapter']` in your plugin and call these from
 * `apply()`. Registrations must happen during plugin setup; after `dispose()`
 * both methods throw `ADAPTER_DISPOSED`.
 */
export interface CompatAdapterService {
  /**
   * Declare one other-agent hook and route it to a DSH seam.
   *
   * @returns the frozen graded result. Never rejects for an unportable asset —
   *   only for a malformed declaration (unknown vendor/event, bad handler).
   */
  registerHook(declaration: HookDeclaration): Promise<CapabilityResult>
  /**
   * Declare other-agent rules files. Always grades `CARRY`: rules are carried
   * verbatim and injected as context at agent start, never executed as policy.
   */
  registerRules(declaration: RulesDeclaration): Promise<CapabilityResult>
  /** What this composition is actually running right now. */
  status(): AdapterStatus
  /** The static capability matrix: what this version can ever do. */
  matrix(): readonly VendorMatrix[]
  /** Unload every bridge and listener; idempotent. */
  dispose(): Promise<void>
}

/** Cordis plugin identity. */
export declare const name: 'compat-adapter'
/** Services consumed by the adapter itself (intentionally none). */
export declare const inject: readonly string[]
/** Loader config schema. */
export declare const Config: unknown
/** Mount the adapter service. */
export declare function apply(ctx: unknown, config?: Config): void

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The compat-adapter service. Present only while the adapter plugin is
     * mounted — a preset that depends on it must declare it in `inject`.
     */
    compatAdapter: CompatAdapterService
  }
}
