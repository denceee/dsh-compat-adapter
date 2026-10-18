#!/usr/bin/env node
/**
 * Live verification against a REAL booted DSH profile.
 *
 * `npm test` boots a real Cordis context, but it does not boot the product
 * launcher. This script closes that gap: it initializes an isolated `$DSH_HOME`
 * profile from the `sdk-minimal` template, installs this bundle with the
 * official `dsh plugin add` path, boots the profile through the shipped
 * `runProfile`, and then exercises the adapter in the live composition:
 *
 *   1. resolve `ctx.compatAdapter` (the service is really provided),
 *   2. print the static capability matrix,
 *   3. register a Claude `PreToolUse` deny hook and fire a real
 *      `tools/pre-execute` waterfall → must be `{kind:'deny'}`,
 *   4. fire a non-matching tool → must stay `allow` (matcher is real),
 *   5. register rules and confirm they carry + inject on `agent/created`,
 *   6. confirm an UNSUPPORTED declaration never becomes executable.
 *
 * Usage:
 *   node scripts/verify-live.mjs [--profile <name>] [--home <dir>] [--keep]
 *
 * Exit code 0 means every assertion passed; anything else prints the failure
 * and exits non-zero. Nothing is faked: assertions are on real return values.
 *
 * @module dsh-compat-adapter/scripts/verify-live
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Locate the installed DSH package directory.
 *
 * @returns {string} the installation root.
 * @throws {Error} when it cannot be found.
 */
function locateDsh() {
  const env = process.env.DSH_INSTALL_DIR
  if (env !== undefined && existsSync(join(env, 'package.json'))) return resolve(env)
  for (const entry of (process.env.PATH ?? '').split(':')) {
    if (entry === '') continue
    const bin = join(entry, 'dsh')
    if (!existsSync(bin)) continue
    try {
      const real = realpathSafe(bin)
      const candidate = dirname(dirname(real))
      if (existsSync(join(candidate, 'package.json'))) return candidate
    } catch {
      /* unreadable candidate */
    }
  }
  const fallback = '/opt/node/lib/node_modules/@deepseek-ai/dsh'
  if (existsSync(join(fallback, 'package.json'))) return fallback
  throw new Error('verify-live: cannot locate the installed @deepseek-ai/dsh; set DSH_INSTALL_DIR')
}

/**
 * `realpathSync` wrapper that keeps the import list tidy.
 *
 * @param {string} path - path to resolve.
 * @returns {string} the real path.
 */
function realpathSafe(path) {
  const fs = require('node:fs')
  return fs.realpathSync(path)
}

/** Minimal `require` for the one synchronous call above. */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

/**
 * Parse CLI arguments.
 *
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{profile: string, home: string, keep: boolean}} parsed options.
 */
function parseArgs(argv) {
  const options = { profile: 'adapter-verify', home: '', keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--home') options.home = resolve(argv[++index])
    else if (arg === '--keep') options.keep = true
  }
  if (options.home === '') options.home = mkdtempSync(join(tmpdir(), 'dsh-adapter-verify-'))
  return options
}

/**
 * A deterministic list of assertions with pass/fail bookkeeping.
 *
 * @returns {{check: (name: string, fn: () => void) => void, results: object[], failures: string[]}} the recorder.
 */
function recorder() {
  const results = []
  const failures = []
  return {
    results,
    failures,
    check(name, fn) {
      try {
        fn()
        results.push({ name, ok: true })
      } catch (error) {
        results.push({ name, ok: false, detail: String(error?.message ?? error) })
        failures.push(`${name}: ${String(error?.message ?? error)}`)
      }
    },
  }
}

/**
 * Write an executable hook script.
 *
 * @param {string} dir - directory to hold the script.
 * @param {string} name - file name.
 * @param {string} body - script body (bash).
 * @returns {string} absolute path.
 */
function writeHookScript(dir, name, body) {
  const file = join(dir, name)
  writeFileSync(file, `#!/usr/bin/env bash\nset -u\n${body}\n`, 'utf8')
  chmodSync(file, 0o755)
  return file
}

/**
 * Re-exec this script under a stdin pipe that is never closed.
 *
 * The SDK app the verification profile mounts registers `exitOnStdinEnd`: when
 * stdin reaches EOF it calls `exit(0)` and the whole composition unloads, which
 * would race every assertion. A shell-inherited stdin is frequently already at
 * EOF (redirected from /dev/null, piped from a finished command, or a closed
 * CI stdin), so the parent process here holds one end of a pipe open and waits
 * for the child to finish. `DSH_VERIFY_LIVE_CHILD=1` marks the child.
 *
 * @param {string[]} argv - this process's arguments.
 * @returns {Promise<number|undefined>} the child's exit code, or undefined when
 *   this process IS the child (or already has live stdin) and should run inline.
 */
async function reexecWithLiveStdin(argv) {
  if (process.env.DSH_VERIFY_LIVE_CHILD === '1') return undefined
  if (process.stdin.isTTY) return undefined
  const { spawn } = await import('node:child_process')
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, DSH_VERIFY_LIVE_CHILD: '1' },
    })
    // Deliberately never end this pipe: the child's stdin must stay readable.
    // The timer only exists to hold the handle; it MUST be cleared when the
    // child exits or this parent would never drain its event loop.
    const keepAlive = setInterval(() => {}, 1 << 30)
    const finish = (fn) => (value) => {
      clearInterval(keepAlive)
      fn(value)
    }
    child.on('error', finish(rejectChild))
    child.on('exit', finish((code) => resolveChild(code ?? 1)))
  })
}

/** Run the live verification. */
async function main() {
  const childCode = await reexecWithLiveStdin(process.argv.slice(2))
  if (childCode !== undefined) {
    process.exitCode = childCode
    return
  }
  const options = parseArgs(process.argv.slice(2))
  const dshDir = locateDsh()
  const out = []
  const say = (line) => {
    out.push(line)
    process.stdout.write(`${line}\n`)
  }

  say(`verify-live: DSH install   ${dshDir}`)
  say(`verify-live: isolated home ${options.home}`)
  say(`verify-live: profile       ${options.profile}`)

  // The bundle must be reachable from the profile without a global install.
  mkdirSync(join(options.home, 'profiles'), { recursive: true })
  const profileDir = join(options.home, 'profiles', options.profile)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  // Link this package into the profile exactly as `dsh plugin add` would.
  const linkTarget = join(profileDir, 'node_modules', 'dsh-compat-adapter')
  rmIfPresent(linkTarget)
  ;(await import('node:fs')).symlinkSync(PROJECT_DIR, linkTarget, 'dir')
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({
      name: `dsh-profile-${options.profile}`,
      private: true,
      dependencies: { 'dsh-compat-adapter': `link:${PROJECT_DIR}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-sdk-minimal', 'dsh-compat-adapter'] } },
    }, null, 2)}\n`,
    'utf8',
  )
  // sdk-minimal has a PTY terminal provider but no `shell` service, which the
  // official hook bridges require. Add the plain bash executor in the profile patch.
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    [
      '# verify-live: sdk-minimal has no `ctx.shell`; the official hook bridges need one.',
      '- insert:',
      '    - id: bash-local-verify',
      "      name: '@deepseek-ai/dsh-bash-local'",
      '      config:',
      '        timeoutMs: 30000',
      '',
    ].join('\n'),
    'utf8',
  )

  process.env.DSH_HOME = options.home
  const { prepareProfile, runProfile } = await import(pathToFileURL(join(dshDir, 'lib', 'profile-boot.js')).href)
  const { createLaunchEnvironmentSnapshot } = await import(
    pathToFileURL(join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-launch-environment', 'lib', 'index.js')).href
  )
  const { scopeTarget } = await import(
    pathToFileURL(join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-scope', 'lib', 'index.js')).href
  )

  const profile = prepareProfile(options.profile, true)
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }])
  const { ctx, shutdown } = await runProfile({
    environment,
    profile: options.profile,
    resolvedProfile: { profile, installAnchor: join(dshDir, 'package.json') },
    patchFiles: [],
    args: [],
  })

  const report = { checks: [], matrix: null, hook: null, rules: null }
  const record = recorder()

  try {
    const adapter = ctx.get('compatAdapter')
    record.check('ctx.compatAdapter is provided by the installed bundle', () => {
      if (adapter === undefined) throw new Error('service missing: the bundle row did not provide ctx.compatAdapter')
    })
    if (adapter === undefined) throw new Error('cannot continue without the service')

    record.check('ctx.shell resolves in the live composition', () => {
      if (ctx.get('shell') === undefined) throw new Error('ctx.shell missing; the profile patch did not add the shell executor')
    })

    const matrix = adapter.matrix()
    report.matrix = matrix.map((vendor) => ({
      vendor: vendor.vendor,
      supported: vendor.supported,
      unsupported: vendor.unsupported,
      rules: vendor.rules.capability,
    }))
    record.check('the matrix covers every vendor, none claiming DIRECT', () => {
      if (matrix.length !== 5) throw new Error(`expected 5 vendors, got ${matrix.length}`)
      for (const vendor of matrix) {
        for (const event of vendor.hooks) {
          if (event.capability === 'DIRECT') throw new Error(`${vendor.vendor} ${event.event} claims DIRECT`)
        }
        if (vendor.rules.capability !== 'CARRY') throw new Error(`${vendor.vendor} rules are not CARRY`)
      }
    })

    // Hook scripts live in the throwaway home so nothing leaks into the repo.
    const hookDir = join(options.home, 'hooks')
    mkdirSync(hookDir, { recursive: true })
    // Scope-filtered seams require a carrier as the dispatch `thisArg`.
    const unkeyed = scopeTarget({}, undefined)

    // ── Copilot: no official bridge, so this proves the adapter's OWN translation
    // reaches DSH. A Copilot hook writes its decision at the TOP level
    // ({permissionDecision}), which the shared hook protocol does not decode, so
    // this check would catch a regression where deny silently became allow.
    const copilotScript = writeHookScript(
      hookDir,
      'copilot-deny.sh',
      `cat >/dev/null\nprintf '%s' '{"permissionDecision":"deny","permissionDecisionReason":"verify-live copilot denial"}'\nexit 0`,
    )
    const copilotReg = await adapter.registerHook({ vendor: 'copilot', event: 'preToolUse', matcher: 'bash', handler: copilotScript })
    report.copilot = { capability: copilotReg.capability, seams: [...copilotReg.seams] }
    record.check('registerHook(copilot) returns ADAPTED on the native translation seam', () => {
      if (copilotReg.capability !== 'ADAPTED') throw new Error(`expected ADAPTED, got ${copilotReg.capability}`)
      if (copilotReg.seams[0] !== 'tools/pre-execute') throw new Error(`unexpected seam ${copilotReg.seams.join(',')}`)
    })
    const copilotDeny = await ctx.waterfall(
      unkeyed,
      'tools/pre-execute',
      { callId: 'verify-copilot', name: 'bash', arguments: { command: 'ls' }, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    )
    record.check('a Copilot preToolUse deny reaches DSH (top-level permissionDecision is decoded)', () => {
      if (copilotDeny.kind !== 'deny') throw new Error(`expected deny, got ${JSON.stringify(copilotDeny)}`)
      if (!String(copilotDeny.reason ?? '').includes('verify-live copilot denial')) {
        throw new Error(`unexpected reason ${JSON.stringify(copilotDeny.reason)}`)
      }
    })
    const copilotOther = await ctx.waterfall(
      unkeyed,
      'tools/pre-execute',
      { callId: 'verify-copilot-2', name: 'edit', arguments: {}, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    )
    record.check('the Copilot matcher is anchored: `bash` does not match `edit`', () => {
      if (copilotOther.kind !== 'allow') throw new Error(`expected allow for edit, got ${JSON.stringify(copilotOther)}`)
    })
    // ── A real deny through the real official bridge ──────────────────────
    const trace = join(options.home, 'deny-trace.log')
    const denyScript = writeHookScript(
      hookDir,
      'deny-write.sh',
      `cat >${join(options.home, 'deny-stdin.json')}\necho ran >> ${trace}\n` +
        `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"verify-live denial"}}'\nexit 0`,
    )
    const registration = await adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', matcher: 'Write', handler: denyScript })
    report.hook = { capability: registration.capability, seams: [...registration.seams], degradations: [...registration.degradations] }
    record.check('registerHook returns ADAPTED with a seam and degradations', () => {
      if (registration.capability !== 'ADAPTED') throw new Error(`expected ADAPTED, got ${registration.capability}`)
      if (registration.seams[0] !== 'tools/pre-execute') throw new Error(`unexpected seam ${registration.seams.join(',')}`)
      if (registration.degradations.length === 0) throw new Error('ADAPTED result lists no degradations')
    })

    const deny = await ctx.waterfall(
      unkeyed,
      'tools/pre-execute',
      { callId: 'verify-deny', name: 'Write', arguments: { file_path: join(options.home, 'x'), content: 'y' }, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    )
    record.check('a declared PreToolUse hook blocks Write at the live tools/pre-execute seam', () => {
      if (deny.kind !== 'deny') throw new Error(`expected deny, got ${JSON.stringify(deny)}`)
      if (!String(deny.reason ?? '').includes('verify-live denial')) throw new Error(`unexpected reason ${JSON.stringify(deny.reason)}`)
    })
    record.check('the hook command really ran (side-effect trace + stdin payload)', () => {
      if (!existsSync(trace)) throw new Error('hook script did not run')
      const payload = JSON.parse(readFileSync(join(options.home, 'deny-stdin.json'), 'utf8'))
      if (payload.hook_event_name !== 'PreToolUse') throw new Error(`unexpected payload ${JSON.stringify(payload)}`)
      if (payload.tool_name !== 'Write') throw new Error(`payload tool_name is ${payload.tool_name}`)
    })

    const allow = await ctx.waterfall(
      unkeyed,
      'tools/pre-execute',
      { callId: 'verify-allow', name: 'Read', arguments: { file_path: join(options.home, 'x') }, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    )
    record.check('the declared matcher is real: a non-matching tool stays allowed', () => {
      if (allow.kind !== 'allow') throw new Error(`expected allow for Read, got ${JSON.stringify(allow)}`)
    })

    // ── Rules carry + inject ─────────────────────────────────────────────
    const rulesDir = join(options.home, 'rules')
    mkdirSync(join(rulesDir, '.claude', 'rules'), { recursive: true })
    writeFileSync(join(rulesDir, 'CLAUDE.md'), '# verify-live rules\n\nunique marker: verify-live-9c21\n', 'utf8')
    writeFileSync(join(rulesDir, '.claude', 'rules', 'api.md'), '# api rules\n', 'utf8')
    const rulesResult = await adapter.registerRules({
      vendor: 'claude',
      source: ['CLAUDE.md', '.claude/rules/*.md'],
      baseDir: rulesDir,
    })
    report.rules = { capability: rulesResult.capability, seams: [...rulesResult.seams] }
    record.check('registerRules returns CARRY on agent/created', () => {
      if (rulesResult.capability !== 'CARRY') throw new Error(`expected CARRY, got ${rulesResult.capability}`)
      if (rulesResult.seams[0] !== 'agent/created') throw new Error(`unexpected seam ${rulesResult.seams.join(',')}`)
    })

    const injected = []
    // `agent/created` is scope-filtered AND its carrier must be keyed to the
    // exact subject the arguments name, so the carrier is built from the agent.
    const fakeAgent = { id: 'verify-session', inject: (message) => injected.push(message) }
    const agentCarrier = scopeTarget({}, fakeAgent)
    await ctx.waterfall(
      agentCarrier,
      'agent/created',
      { agent: fakeAgent, source: 'startup' },
      async () => undefined,
    )
    // Rule injection resolves the message constructor lazily, so settle the
    // pending microtasks before asserting.
    await new Promise((resolve) => setTimeout(resolve, 100))
    report.rules.injectedMessages = injected.length
    record.check('carried rules are injected as sourced context on agent/created', () => {
      if (injected.length !== 1) throw new Error(`expected 1 injected message, got ${injected.length}`)
      const [message] = injected
      if (message.source.kind !== 'compat-adapter-rules') throw new Error(`unexpected source kind ${message.source.kind}`)
      if (message.source.vendor !== 'claude') throw new Error(`unexpected vendor ${message.source.vendor}`)
      const text = message.content.map((block) => block.text ?? '').join('')
      if (!text.includes('verify-live-9c21')) throw new Error('injected text lost the carried content')
      if (!text.includes('sha256:')) throw new Error('injected text lost the provenance hash')
    })

    // ── Fail-closed ──────────────────────────────────────────────────────
    // Every declared event now has a seam, so fail-closed is exercised through the
    // path that still refuses: a JS function handler cannot cross the declaration
    // boundary (this adapter does not execute foreign code in the Host).
    const copilotRefused = await adapter.registerHook({ vendor: 'copilot', event: 'permissionRequest', handler: () => ({}) })
    record.check('a Copilot event with no faithful mapping is refused with a reason', () => {
      if (copilotRefused.capability !== 'UNSUPPORTED') throw new Error(`expected UNSUPPORTED, got ${copilotRefused.capability}`)
      if (String(copilotRefused.reason ?? '').length < 40) throw new Error('refusal has no substantive reason')
    })
    // JS function handlers remain the refused path on every vendor now.
    const refused = await adapter.registerHook({ vendor: 'opencode', event: 'tool.execute.before', handler: () => ({}) })
    report.refused = { capability: refused.capability, reasonLength: String(refused.reason ?? '').length }
    const status = adapter.status()
    record.check('an UNSUPPORTED declaration never becomes executable', () => {
      if (refused.capability !== 'UNSUPPORTED') throw new Error(`expected UNSUPPORTED, got ${refused.capability}`)
      if (String(refused.reason ?? '').length < 40) throw new Error('UNSUPPORTED refusal has no substantive reason')
      const live = status.hooks.find((hook) => hook.event === 'tool.execute.before')
      if (live !== undefined && live.capability !== 'UNSUPPORTED') throw new Error('refused hook appears executable in status()')
      if (status.counts.executableHooks !== 2) {
        throw new Error(`expected exactly 2 executable hooks (1 claude + 1 copilot), got ${status.counts.executableHooks}`)
      }
      void 0
    })
    record.check('status() reports the carried rules with hashes', () => {
      if (status.counts.rules !== 1) throw new Error(`expected 1 rules set, got ${status.counts.rules}`)
      if (status.counts.carriedFiles !== 2) throw new Error(`expected 2 carried files, got ${status.counts.carriedFiles}`)
      for (const file of status.rules[0].files) {
        if (!/^[0-9a-f]{64}$/u.test(file.sha256)) throw new Error(`bad sha256 ${file.sha256}`)
      }
    })
    report.status = status.counts
  } finally {
    for (const check of record.results) {
      say(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.ok ? '' : ` — ${check.detail}`}`)
    }
    if (options.keep) say(`verify-live: kept ${options.home} (--keep)`)
    else rmSync(options.home, { recursive: true, force: true })
    try {
      await shutdown.dispose?.()
    } catch (error) {
      say(`verify-live: shutdown warning: ${String(error)}`)
    }
  }

  say('')
  say('verify-live matrix:')
  for (const vendor of report.matrix ?? []) {
    say(`  ${vendor.vendor.padEnd(10)} hooks=${String(vendor.supported).padStart(2)} supported / ${String(vendor.unsupported).padStart(2)} refused   rules=${vendor.rules}`)
  }
  say('')
  say(`verify-live: ${record.failures.length === 0 ? 'PASS' : `FAIL (${record.failures.length} check(s))`}`)
  const exitCode = record.failures.length === 0 ? 0 : 1
  // Exit explicitly: the booted composition may still hold product handles.
  process.exit(exitCode)
}

/** Remove a path if it exists (symlink-safe). */
function rmIfPresent(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* nothing to remove */
  }
}

main().catch((error) => {
  process.stderr.write(`verify-live: fatal: ${String(error?.stack ?? error)}\n`)
  // Exit explicitly: the booted composition keeps active handles (webserver,
  // terminal providers, …) that never drain on their own, so setting exitCode
  // alone leaves the process hanging until an external timeout kills it.
  process.exit(1)
})

// Belt and braces: a promise that never settles (a hook awaiting a dead seam)
// must not hang CI forever — report and fail instead of waiting for the timeout.
const HARD_TIMEOUT_MS = 240_000
const hardTimer = setTimeout(() => {
  process.stderr.write(`verify-live: fatal: did not finish within ${HARD_TIMEOUT_MS} ms; failing instead of hanging\n`)
  process.exit(1)
}, HARD_TIMEOUT_MS)
hardTimer.unref?.()
