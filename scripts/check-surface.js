#!/usr/bin/env node
/**
 * Loud surface check.
 *
 * DSH is a developer preview; this script asserts that every DSH surface
 * element `src/surface.js` claims still exists in the INSTALLED Harness. Run it
 * after a DSH upgrade and before trusting the adapter:
 *
 *   node scripts/check-surface.js                 # discover the installed DSH
 *   node scripts/check-surface.js --dsh <dir>     # explicit installation
 *   node scripts/check-surface.js --json          # machine-readable report
 *
 * Exit codes: 0 every element present; 1 at least one element missing or
 * unverifiable. Missing elements are printed by name, never swallowed.
 *
 * @module dsh-compat-adapter/scripts/check-surface
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Package that provides each service the adapter reads through `ctx.get(...)`. */
const SERVICE_PROVIDERS = Object.freeze({
  shell: '@deepseek-ai/dsh-shell',
  sessionProjections: '@deepseek-ai/dsh-session-projection',
  shellEnv: '@deepseek-ai/dsh-shell-env',
  workspaceChanges: '@deepseek-ai/dsh-workspace-changes',
})

/**
 * Locate the installed `@deepseek-ai/dsh` package directory.
 *
 * @param {string|undefined} explicit - `--dsh` value.
 * @returns {string} the resolved installation directory.
 * @throws {Error} when no installation can be found.
 */
function locateDsh(explicit) {
  const candidates = []
  if (explicit !== undefined) candidates.push(resolve(explicit))
  if (process.env.DSH_INSTALL_DIR) candidates.push(resolve(process.env.DSH_INSTALL_DIR))
  for (const entry of (process.env.PATH ?? '').split(':')) {
    if (!entry) continue
    const bin = join(entry, 'dsh')
    if (!existsSync(bin)) continue
    try {
      candidates.push(dirname(dirname(realpathSync(bin))))
    } catch {
      /* unreadable candidate: skip */
    }
  }
  candidates.push('/opt/node/lib/node_modules/@deepseek-ai/dsh')
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  throw new Error('check-surface: cannot locate the installed @deepseek-ai/dsh package. Pass --dsh <dir> or set DSH_INSTALL_DIR.')
}

/**
 * Resolve one installed package's entry module URL.
 *
 * @param {string} modulesDir - `<dsh>/node_modules`.
 * @param {string} packageName - package specifier.
 * @returns {string} file URL of the entry module.
 * @throws {Error} when the package is not installed.
 */
function installedEntryUrl(modulesDir, packageName) {
  const packageDir = join(modulesDir, packageName)
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`package ${packageName} is not installed under ${modulesDir}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const exportEntry = typeof manifest.exports === 'string' ? manifest.exports : manifest.exports?.['.']
  const target = typeof exportEntry === 'string' ? exportEntry : (exportEntry?.default ?? manifest.main ?? './index.js')
  return pathToFileURL(join(packageDir, target)).href
}

/**
 * Build a text index of every installed package's declaration + build output,
 * so one pass can answer all event/service queries. Bounded per file.
 *
 * @param {string} modulesDir - `<dsh>/node_modules`.
 * @returns {Map<string, string>} package name → concatenated text (truncated per file).
 */
function buildTextIndex(modulesDir) {
  const scopeDir = join(modulesDir, '@deepseek-ai')
  const index = new Map()
  if (!existsSync(scopeDir)) return index
  const MAX_FILE_BYTES = 4 * 1024 * 1024
  const MAX_PACKAGE_BYTES = 16 * 1024 * 1024
  for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packageName = `@deepseek-ai/${entry.name}`
    const libDir = join(scopeDir, entry.name, 'lib')
    if (!existsSync(libDir)) continue
    const chunks = []
    let total = 0
    const walk = (dir) => {
      if (total > MAX_PACKAGE_BYTES) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const child of entries) {
        const full = join(dir, child.name)
        if (child.isDirectory()) {
          if (child.name !== 'node_modules') walk(full)
          continue
        }
        if (!/\.(d\.ts|js|mjs)$/u.test(child.name)) continue
        try {
          const stats = statSync(full)
          if (stats.size > MAX_FILE_BYTES) continue
          const text = readFileSync(full, 'utf8')
          chunks.push(text)
          total += text.length
        } catch {
          /* unreadable file: skip */
        }
      }
    }
    walk(libDir)
    if (chunks.length > 0) index.set(packageName, chunks.join('\n'))
  }
  return index
}

/**
 * Whether any installed package text contains one of the needles.
 *
 * @param {Map<string, string>} index - package text index.
 * @param {string[]} needles - literal strings to find.
 * @returns {{present: boolean, packages: string[]}} where it was found.
 */
function findNeedles(index, needles) {
  const packages = []
  for (const [packageName, text] of index) {
    if (needles.some((needle) => text.includes(needle))) packages.push(packageName)
  }
  return { present: packages.length > 0, packages }
}

/**
 * Run every surface assertion.
 *
 * @param {string} installDir - resolved DSH package directory.
 * @param {string} projectDir - adapter project root (holds `src/surface.js`).
 * @returns {Promise<{ok: boolean, version: string, checks: object[], failures: string[]}>} the report.
 */
async function checkSurface(installDir, projectDir) {
  const { DSH_SURFACE } = await import(pathToFileURL(join(projectDir, 'src', 'surface.js')).href)
  const modulesDir = join(installDir, 'node_modules')
  const index = buildTextIndex(modulesDir)
  const checks = []
  const failures = []

  const version = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version
  const versionOk = version === DSH_SURFACE.dshVersion
  checks.push({ kind: 'version', element: 'dshVersion', expected: DSH_SURFACE.dshVersion, actual: version, ok: versionOk })
  if (!versionOk) {
    failures.push(
      `version: adapter targets DSH ${DSH_SURFACE.dshVersion} but ${installDir} is ${version}. Review the DSH changelog, update src/surface.js and peerDependencies, then re-run.`,
    )
  }

  for (const [packageName, symbols] of Object.entries(DSH_SURFACE.packages)) {
    let namespace
    try {
      namespace = await import(installedEntryUrl(modulesDir, packageName))
      checks.push({ kind: 'package', element: packageName, ok: true })
    } catch (error) {
      const detail = `not importable (${String(error?.message ?? error)})`
      checks.push({ kind: 'package', element: packageName, ok: false, detail })
      failures.push(`package ${packageName}: ${detail}`)
      continue
    }
    for (const symbol of symbols) {
      const present = symbol === 'default' ? namespace.default !== undefined : namespace[symbol] !== undefined
      checks.push({ kind: 'export', element: `${packageName}#${symbol}`, ok: present })
      if (!present) failures.push(`export ${packageName}#${symbol}: missing from the installed module`)
    }
  }

  for (const event of DSH_SURFACE.events) {
    const found = findNeedles(index, [`'${event}'`, `"${event}"`])
    checks.push({ kind: 'event', element: event, ok: found.present, foundIn: found.packages.slice(0, 5) })
    if (!found.present) failures.push(`event ${event}: no installed package declares or dispatches it (searched lib/types and build output)`)
  }

  for (const service of DSH_SURFACE.services) {
    const provider = SERVICE_PROVIDERS[service]
    const present = provider !== undefined && existsSync(join(modulesDir, provider, 'package.json'))
    checks.push({ kind: 'service', element: service, provider, ok: present })
    if (!present) failures.push(`service ${service}: provider package ${provider ?? '(unknown)'} is not installed`)
  }

  for (const sessionEvent of DSH_SURFACE.sessionEvents) {
    const found = findNeedles(index, [`'${sessionEvent}'`, `"${sessionEvent}"`])
    checks.push({ kind: 'session-event', element: sessionEvent, ok: found.present, foundIn: found.packages.slice(0, 5) })
    if (!found.present) failures.push(`session event ${sessionEvent}: no installed package declares it`)
  }

  // A vendor adapted without an official bridge must not gain one silently: the
  // adapter's own translation layer would then compete with it.
  for (const vendor of DSH_SURFACE.bridgeLessVendors ?? []) {
    const shipped = existsSync(join(modulesDir, `@deepseek-ai/dsh-hooks-${vendor}`))
    checks.push({ kind: 'bridge-absence', element: `@deepseek-ai/dsh-hooks-${vendor}`, ok: !shipped })
    if (shipped) {
      failures.push(
        `bridge @deepseek-ai/dsh-hooks-${vendor} now exists but this adapter translates that vendor by hand. ` +
          'Review src/vendors/' + vendor + '.js and switch the rows to the official bridge, or delete the translation layer.',
      )
    }
  }

  return { ok: failures.length === 0, version, checks, failures }
}

/** CLI entry point. */
async function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const dshIndex = argv.indexOf('--dsh')
  const explicit = dshIndex === -1 ? undefined : argv[dshIndex + 1]
  const projectDir = resolve(dirname(new URL(import.meta.url).pathname), '..')
  const installDir = locateDsh(explicit)
  const report = await checkSurface(installDir, projectDir)
  if (json) {
    process.stdout.write(`${JSON.stringify({ installDir, ...report }, null, 2)}\n`)
    process.exitCode = report.ok ? 0 : 1
    return
  }
  process.stdout.write(`check-surface: DSH at ${installDir} (version ${report.version}; adapter targets ${report.checks[0]?.expected ?? '?'})\n`)
  for (const check of report.checks) {
    if (!check.ok) continue
    if (check.kind === 'export' || check.kind === 'event' || check.kind === 'session-event' || check.kind === 'service') {
      process.stdout.write(`  ok   ${check.kind} ${check.element}${check.foundIn === undefined ? '' : `  (${check.foundIn.join(', ')})`}\n`)
    }
  }
  for (const failure of report.failures) process.stdout.write(`  FAIL ${failure}\n`)
  process.stdout.write(
    report.ok
      ? 'check-surface: OK — every declared DSH surface element is present in the installed Harness\n'
      : `check-surface: ${report.failures.length} failure(s) — the adapter must not be trusted until they are fixed\n`,
  )
  process.exitCode = report.ok ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`check-surface: ${String(error?.stack ?? error)}\n`)
  process.exitCode = 1
})
