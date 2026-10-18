/**
 * Test-only module-resolution bootstrap.
 *
 * Unit tests import the adapter's modules directly in plain Node, where
 * `@deepseek-ai/*` packages are not on the module path. The harness resolves
 * them through SNode's internal loader, so this shim registers a synchronous
 * resolution hook mapping `@deepseek-ai/<pkg>` (and its subpaths) to the
 * installed DSH installation's `node_modules`.
 *
 * The DSH installation is discovered from, in order:
 *   1. `$DSH_INSTALL_DIR` (tests/CI may set it),
 *   2. the real path of the `dsh` binary on PATH,
 *   3. the known global install prefix used by this environment.
 *
 * If none is found, tests fail loudly: a unit test that silently skips the real
 * DSH surface would defeat the point of check-surface.
 *
 * Load with: `node --import ./test/helpers/register-dsh-resolver.js --test test/`
 *
 * @module dsh-compat-adapter/test/helpers/register-dsh-resolver
 */

import { registerHooks } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Locate the DSH installation root (the directory holding `package.json` and `node_modules`). */
export function findDshInstall() {
  const candidates = []
  if (process.env.DSH_INSTALL_DIR) candidates.push(process.env.DSH_INSTALL_DIR)
  for (const entry of (process.env.PATH ?? '').split(':')) {
    if (!entry) continue
    const bin = join(entry, 'dsh')
    if (!existsSync(bin)) continue
    try {
      const real = realpathSync(bin)
      // <root>/lib/bin.js → root
      candidates.push(dirname(dirname(real)))
    } catch {
      /* ignore */
    }
  }
  candidates.push('/opt/node/lib/node_modules/@deepseek-ai/dsh')
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'cordis'))) {
      return candidate
    }
  }
  throw new Error(
    'dsh-compat-adapter tests: cannot locate the installed DSH. Set DSH_INSTALL_DIR to the @deepseek-ai/dsh package directory.',
  )
}

/** The DSH installation root used by this test process. */
export const DSH_INSTALL = findDshInstall()

/** Directory holding the installed `@deepseek-ai/*` packages. */
export const DSH_MODULES = join(DSH_INSTALL, 'node_modules')

/** Resolve one installed package by name, honoring its `exports` map. */
function resolveInstalledPackage(specifier) {
  const segments = specifier.split('/')
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  const subpath = specifier.slice(name.length)
  const packageDir = join(DSH_MODULES, name)
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (subpath === '') {
    const exportsEntry = typeof manifest.exports === 'string' ? manifest.exports : manifest.exports?.['.']
    const target = typeof exportsEntry === 'string' ? exportsEntry : exportsEntry?.default
    if (typeof target === 'string') return join(packageDir, target)
    if (typeof manifest.main === 'string') return join(packageDir, manifest.main)
    return join(packageDir, 'index.js')
  }
  const exportKey = `.${subpath}`
  const exportsEntry = typeof manifest.exports === 'object' ? manifest.exports?.[exportKey] : undefined
  const target = typeof exportsEntry === 'string' ? exportsEntry : exportsEntry?.default
  if (typeof target === 'string') return join(packageDir, target)
  return join(packageDir, subpath.replace(/^\//u, ''))
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, context)
    const file = resolveInstalledPackage(specifier)
    if (file === undefined || !existsSync(file)) return nextResolve(specifier, context)
    return { url: pathToFileURL(file).href, shortCircuit: true }
  },
})
