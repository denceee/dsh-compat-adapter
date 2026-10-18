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
const WORK = mkdtempSync(join(tmpdir(), 'dsh-compat-installed-'))
const DSH = '/opt/node/lib/node_modules/@deepseek-ai/dsh'
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
  fs.writeFileSync(deny, `#!/usr/bin/env bash
cat >/dev/null
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
  out.deny.nonMatch = await ctx.waterfall(unkeyed, 'tools/pre-execute',
    { callId: 'y', name: 'Read', arguments: { file_path: '/tmp/nope' }, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }))

  // 3) 规则携带
  const rulesDir = join(WORK, 'rules'); fs.mkdirSync(rulesDir, { recursive: true })
  fs.writeFileSync(`${rulesDir}/CLAUDE.md`, '# rules\n\nmarker: installed-check\n')
  const rr = await adapter.registerRules({ vendor: 'claude', source: 'CLAUDE.md', baseDir: rulesDir })
  const injected = []
  const fakeAgent = { id: 's', inject: m => injected.push(m) }
  // agent/created 的 carrier 必须按 subject（该 agent 对象）keyed
  await ctx.waterfall(scopeTarget({}, fakeAgent), 'agent/created', { agent: fakeAgent, source: 'startup' }, async () => undefined)
  out.rules = { capability: rr.capability, injected: injected.length, sourceKind: injected[0]?.source?.kind }

  out.status = adapter.status().counts
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
fs.rmSync(WORK, { recursive: true, force: true })
const failures = []
if (out.service.compatAdapter !== true) failures.push('ctx.compatAdapter is not provided by the installed profile')
if (out.deny && out.deny.capability !== 'ADAPTED') failures.push(`hook was not adapted (got ${out.deny.capability}); is ctx.shell mounted in this profile?`)
if (out.deny && out.deny.decision?.kind !== 'deny') failures.push(`hook did not deny (got ${out.deny.decision?.kind})`)
if (out.rules && out.rules.injected !== 1) failures.push(`rules were not injected (got ${out.rules.injected})`)
process.stderr.write(failures.length === 0
  ? 'verify-installed: PASS — the installed bundle is live in this profile\n'
  : `verify-installed: FAIL\n${failures.map((line) => `  - ${line}`).join('\n')}\n`)
await shutdown.dispose?.()
process.exit(failures.length === 0 ? 0 : 1)
