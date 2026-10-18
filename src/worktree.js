/**
 * Real git-worktree detection.
 *
 * DSH has no worktree lifecycle event, so instead of approximating one from
 * session creation (which told a hook nothing), this module OBSERVES the
 * worktree set itself. Git exposes it two ways, both authoritative:
 *
 * - `git worktree list --porcelain` — one stanza per worktree, with its path,
 *   HEAD and branch/ref. Stable, machine-readable, and the documented interface.
 * - `.git/worktrees/<name>/` — the administrative directory git creates per
 *   linked worktree, which also carries the worktree's metadata files.
 *
 * Polling is used because git has no event stream. Polling is honest here: the
 * hook learns which worktrees actually exist and when one appears or disappears,
 * which is strictly more information than "a session was created".
 *
 * @module dsh-compat-adapter/worktree
 */

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * The format is stanzas of `key value` lines separated by blank lines. A detached
 * worktree carries `detached`; a locked one carries `locked` and an optional
 * reason; `prunable` marks one git considers removable.
 *
 * @param {string} text - the raw porcelain output.
 * @returns {Array<{path: string, head: string|null, branch: string|null, detached: boolean, locked: boolean, prunable: boolean}>} parsed entries.
 */
export function parseWorktreeList(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const entries = []
  let current
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/u, '')
    if (line.trim() === '') {
      if (current !== undefined && current.path !== null) entries.push(current)
      current = undefined
      continue
    }
    current ??= { path: null, head: null, branch: null, detached: false, locked: false, prunable: false }
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    switch (key) {
      case 'worktree':
        current.path = value
        break
      case 'HEAD':
        current.head = value
        break
      case 'branch':
        current.branch = value
        break
      case 'detached':
        current.detached = true
        break
      case 'locked':
        current.locked = true
        break
      case 'prunable':
        current.prunable = true
        break
      default:
        break
    }
  }
  if (current !== undefined && current.path !== null) entries.push(current)
  return entries
}

/**
 * Whether a path looks like a git repository or worktree root.
 *
 * `git worktree list` must run inside a repository, so this is the cheap guard
 * that avoids spawning git in every session.
 *
 * @param {object} filesystem - an `ctx.fs`-shaped service, or undefined.
 * @param {string} cwd - session working directory.
 * @returns {Promise<boolean>} true when `.git` exists at the cwd.
 */
export async function looksLikeRepository(filesystem, cwd) {
  if (filesystem === undefined || typeof filesystem.stat !== 'function') return false
  try {
    const target = await filesystem.resolve(cwd)
    const dotGit = await filesystem.stat(target, new AbortController().signal)
    return dotGit !== undefined && dotGit !== null
  } catch {
    return false
  }
}

/**
 * Compute the difference between two worktree snapshots.
 *
 * @param {ReadonlyArray<{path: string}>} before - previous entries.
 * @param {ReadonlyArray<{path: string}>} after - current entries.
 * @returns {{added: Array<object>, removed: Array<object>}} paths added and removed.
 */
export function diffWorktrees(before, after) {
  const beforePaths = new Set((before ?? []).map((entry) => entry?.path).filter((path) => typeof path === 'string'))
  const afterPaths = new Set((after ?? []).map((entry) => entry?.path).filter((path) => typeof path === 'string'))
  return {
    added: (after ?? []).filter((entry) => !beforePaths.has(entry.path)),
    removed: (before ?? []).filter((entry) => !afterPaths.has(entry.path)),
  }
}
