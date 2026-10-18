/**
 * Confirm an ALREADY-INSTALLED bundle is really live.
 *
 * `verify-live.mjs` proves the adapter works; this script proves the specific
 * thing a user asks after installing: "is it actually in effect in MY profile?".
 * It boots an existing profile (installed through `dsh plugin add`) with the real
 * launcher and asserts the service is provided and functioning — the
 * configuration row existing is NOT enough evidence.
 *
 * Prerequisite: the bundle must already be installed in that profile, e.g.
 *   DSH_HOME=<home> dsh plugin --profile <name> add <this package>
 *
 * Usage:
 *   DSH_HOME=<home> node scripts/verify-installed.mjs --profile <name>
 *
 * Exit code 0 when the service is live and every assertion passes.
 */
import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORK = mkdtempSync(join(tmpdir(), 'dsh-compat-installed-'))
const DSH = '/opt/node/lib/node_modules/@deepseek-ai/dsh'

/**
 * Re-exec this script under a stdin pipe that is never closed.
 *
 * The SDK app a user profile mounts registers `exitOnStdinEnd`: when stdin
 * reaches EOF it calls `exit(0)` and unloads the whole composition. That is
 * indistinguishable from "the plugin failed" at the assertion sites above —
 * it surfaces as `ADAPTER_DISPOSED` on the next `registerRules` call, because
 * the adapter was torn down mid-check. A shell-inherited stdin is frequently
 * already at EOF (redirected from /dev/null, piped from a finished command, or
 * a closed CI stdin), so the parent holds one end of a pipe open and waits for
 * the child. `DSH_VERIFY_INSTALLED_CHILD=1` marks the child.
 *
 * @param {string[]} argv - this process's arguments.
 * @returns {Promise<number|undefined>} the child's exit code, or undefined when
 *   this process IS the child (or already has live stdin) and should run inline.
 */
async function reexecWithLiveStdin(argv) {
  if (process.env.DSH_VERIFY_INSTALLED_CHILD === '1') return undefined
  if (process.stdin.isTTY) return undefined
  const { spawn } = await import('node:child_process')
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, DSH_VERIFY_INSTALLED_CHILD: '1' },
    })
    // Deliberately never end this pipe: the child's stdin must stay readable.
    // The timer only holds the handle; it MUST be cleared when the child exits,
    // or this parent would never drain its event loop.
    const keepAlive = setInterval(() => {}, 1 << 30)
    const finish = (fn) => (value) => {
      clearInterval(keepAlive)
      fn(value)
    }
    child.on('error', finish(rejectChild))
    child.on('exit', finish((code) => resolveChild(code ?? 1)))
  })
}

/** Boot the named profile and assert the installed bundle is live. */
async function main() {
  const childCode = await reexecWithLiveStdin(process.argv.slice(2))
  if (childCode !== undefined) {
    process.exitCode = childCode
    return
  }

  const { prepareProfile, runProfile } = await import(`${DSH}/lib/profile-boot.js`)
  const { createLaunchEnvironmentSnapshot } = await import(`${DSH}/node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js`)
  const { scopeTarget } = await import(`${DSH}/node_modules/@deepseek-ai/dsh-scope/lib/index.js`)

  const argv = process.argv.slice(2)
  const nameIndex = argv.indexOf('--profile')
  const profileName = nameIndex === -1 ? undefined : argv[nameIndex + 1]
  if (profileName === undefined) {
    process.stderr.write('verify-installed: pass --profile <name> (the profile the bundle was installed into)\n')
    process.exitCode = 2
    process.exit(2)
  }
  const profile = prepareProfile(profileName, true)
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }])
  const { ctx, shutdown } = await runProfile({
    environment, profile: profileName,
    resolvedProfile: { profile, installAnchor: `${DSH}/package.json` },
    patchFiles: [], args: [],
  })

  const out = { profile: profileName, service: {}, matrix: null, deny: null, rules: null, status: null }
  const adapter = ctx.get('compatAdapter')
  out.service.compatAdapter = adapter !== undefined
  out.service.shell = ctx.get('shell') !== undefined

  if (adapter) {
    // 1) 静态能力矩阵
    out.matrix = adapter.matrix().map(v => `${v.vendor}: ${v.supported} supported / ${v.unsupported} refused, rules=${v.rules.capability}`)

    // 2) 真 hook：声明 → 挂官方桥 → 触发 seam
    const hookDir = join(WORK, 'hooks'); fs.mkdirSync(hookDir, { recursive: true })
    const deny = `${hookDir}/deny.sh`
    // The hook writes a trace unconditionally, so a failure can be attributed:
    // "hook never ran" (the profile's shell executor refused the command — e.g. a
    // sandbox-confined executor on a host with no sandbox backend) is a very
    // different finding from "hook ran but its deny was ignored".
    const traceFile = `${hookDir}/trace.txt`
    fs.writeFileSync(deny, `#!/usr/bin/env bash
cat >/dev/null
echo ran >> ${traceFile}
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"installed-plugin-denial"}}'
exit 0
`)
    fs.chmodSync(deny, 0o755)
    const reg = await adapter.registerHook({ vendor: 'claude', event: 'PreToolUse', matcher: 'Write', handler: deny })
    out.deny = { capability: reg.capability, seams: [...reg.seams] }
    const unkeyed = scopeTarget({}, undefined)
    out.deny.decision = await ctx.waterfall(unkeyed, 'tools/pre-execute',
      { callId: 'x', name: 'Write', arguments: { file_path: '/tmp/nope' }, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }))
    out.deny.hookRan = fs.existsSync(traceFile)
    out.deny.nonMatch = await ctx.waterfall(unkeyed, 'tools/pre-execute',
      { callId: 'y', name: 'Read', arguments: { file_path: '/tmp/nope' }, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }))

    // 3) 规则携带
    const rulesDir = join(WORK, 'rules'); fs.mkdirSync(rulesDir, { recursive: true })
    fs.writeFileSync(`${rulesDir}/CLAUDE.md`, '# rules\n\nmarker: installed-check\n')
    const rr = await adapter.registerRules({ vendor: 'claude', source: 'CLAUDE.md', baseDir: rulesDir })
    const injected = []
    // Rules reach an agent through `agent/created`, which DSH dispatches with
    // `ctx.serial(carrier, 'agent/created', ...)` from AgentService.announce() —
    // NOT through a bare `ctx.waterfall`. Driving the real registry is therefore
    // the only faithful check: a synthetic waterfall with a hand-built agent
    // silently reported "0 injected" on profiles that mount the scope plugin,
    // while the real product path injected correctly. Use `ctx.agents` when the
    // profile has one, and only fall back to a synthetic dispatch otherwise.
    //
    // The agent stub still needs a `session`: DSH's own GoalService does
    // `WeakMap.set(agent.session, ...)` inside its `agent/created` listener, so an
    // agent without one makes the dispatch throw inside DSH (the
    // "Invalid value used as weak map key" crash this check previously hit).
    // Registering through the real registry runs EVERY mounted `agent/created`
    // listener, including the official Claude bridge, which reads
    // `agent.session.header.id` / `.cwd`. The stub therefore carries a session
    // header, and one shared id because DSH asserts `agent.id === session.id`.
    const stubId = 'installed-check-agent'
    const fakeSession = { id: stubId, header: { id: stubId, cwd: process.cwd() } }
    const fakeAgent = { id: stubId, session: fakeSession, inject: m => injected.push(m) }
    const agents = ctx.get('agents')
    if (agents !== undefined && typeof agents.register === 'function') {
      await agents.register(fakeAgent)
    } else {
      await ctx.serial(scopeTarget({}, fakeAgent), 'agent/created', { agent: fakeAgent, source: 'startup' })
    }
    // Rule injection resolves the message constructor lazily, so settle the
    // pending microtasks before reading the count (same wait as verify-live.mjs).
    await new Promise((resolve) => setTimeout(resolve, 150))
    out.rules = { capability: rr.capability, injected: injected.length, sourceKind: injected[0]?.source?.kind }

    out.status = adapter.status().counts
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  fs.rmSync(WORK, { recursive: true, force: true })
  const failures = []
  if (out.service.compatAdapter !== true) failures.push('ctx.compatAdapter is not provided by the installed profile')
  if (out.deny && out.deny.capability !== 'ADAPTED') failures.push(`hook was not adapted (got ${out.deny.capability}); is ctx.shell mounted in this profile?`)
  if (out.deny && out.deny.decision?.kind !== 'deny') {
    // Attribute the failure instead of reporting a bare "allow": if the hook
    // command never ran, the seam was fine and the profile's shell executor is
    // what blocked it.
    failures.push(out.deny.hookRan === false
      ? 'the hook command never ran, so it could not deny: this profile\'s shell executor refused it '
        + '(a sandbox-confined executor on a host with no sandbox backend does this; retry with '
        + 'DSH_PERMISSION_MODE=danger-full-access to distinguish an environment limit from a plugin bug)'
      : `hook did not deny (got ${out.deny.decision?.kind})`)
  }
  if (out.rules && out.rules.injected !== 1) failures.push(`rules were not injected (got ${out.rules.injected})`)
  process.stderr.write(failures.length === 0
    ? 'verify-installed: PASS — the installed bundle is live in this profile\n'
    : `verify-installed: FAIL\n${failures.map((line) => `  - ${line}`).join('\n')}\n`)
  await shutdown.dispose?.()
  process.exit(failures.length === 0 ? 0 : 1)
}

await main()
