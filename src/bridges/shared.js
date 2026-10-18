/**
 * Helpers shared by bridges this plugin builds.
 *
 * The official DSH bridges each implement their own matcher semantics inline.
 * A bridge built here needs the same predicate, but must not duplicate the
 * protocol library: `matchesMatcher` from `@deepseek-ai/dsh-hook-protocol` is the
 * single implementation, reached lazily so the package still imports with no
 * static peer dependency.
 *
 * @module dsh-compat-adapter/bridges/shared
 */

import { loadPeer } from '../peer.js'

/**
 * Load the protocol's matcher predicate and expose it as a plain callable.
 *
 * A missing protocol package yields a predicate that accepts everything, which is
 * the permissive default: a bridge that cannot evaluate a matcher must not
 * silently skip every hook (that would look like "the hook ran and allowed").
 *
 * @returns {Promise<{matches: (matcher: string|undefined, query: string|undefined) => boolean}>} the matcher helper.
 */
export async function loadCorpus() {
  // The protocol library exposes only two matcher modes, and NEITHER matches
  // Copilot's rule: Copilot compiles every matcher as `^(?:PATTERN)$` and
  // requires a FULL match, while the 'codex' mode is unanchored and
  // 'claude-code' applies its own literal-or-regex rule. Using either would let
  // `bas` fire for `bash`, silently broadening what a policy hook sees, so the
  // anchored semantics are implemented here.
  await loadPeer('@deepseek-ai/dsh-hook-protocol').catch(() => undefined)
  return {
    /**
     * Evaluate one Copilot matcher as an anchored regular expression.
     *
     * An invalid pattern skips the hook entirely, which is Copilot's documented
     * behaviour: a typo must not become a blanket policy.
     *
     * @param {string|undefined} matcher - the declared pattern.
     * @param {string|undefined} query - the value to test.
     * @returns {boolean} whether the hook should fire.
     */
    matches(matcher, query) {
      if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true
      if (typeof matcher !== 'string') return true
      if (typeof query !== 'string') return false
      try {
        return new RegExp(`^(?:${matcher})$`, 'u').test(query)
      } catch {
        return false
      }
    },
  }
}
