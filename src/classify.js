/**
 * Decision classification shared by the observe-only router and the smoke
 * test fixtures.
 *
 * The sanctioned blocking contract is stdout
 * `hookSpecificOutput.permissionDecision` (`deny` / `ask`) with exit code 0.
 * The adapter never *generates* exit-2 handlers, but it must still classify one
 * a preset author wrote by hand, so the audit record can report the decision
 * the reference tool would have taken instead of dropping it silently.
 *
 * @module dsh-compat-adapter/classify
 */

/**
 * @typedef {object} ClassifiedDecision
 * @property {'none'|'allow'|'deny'|'ask'|'block'|'stop'|'error'} decision
 * @property {boolean} executable  True when the reference tool would have blocked/asked/stopped.
 * @property {string} [reason]     The hook-supplied reason, when present.
 */

/**
 * Classify one parsed hook output.
 *
 * @param {import('@deepseek-ai/dsh-hook-protocol').HookOutput} output - decoded hook output.
 * @returns {ClassifiedDecision} the classification.
 */
export function classifyExit(output) {
  const decision = output.decision ?? 'none'
  const executable = decision === 'deny' || decision === 'block' || decision === 'ask' || output.continue === false
  const reason = output.reason ?? (output.continue === false ? output.stopReason : undefined)
  return {
    decision: output.continue === false ? 'stop' : decision,
    executable,
    ...(reason === undefined || reason === '' ? {} : { reason }),
  }
}

/**
 * Whether a hook stdout payload carries an explicit blocking contract. Used by
 * tests to prove generated examples never rely on exit code 2.
 *
 * @param {string} stdout - raw hook stdout.
 * @returns {boolean} true when the JSON has a permissionDecision or decision field.
 */
export function hasStructuredDecision(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    if (parsed === null || typeof parsed !== 'object') return false
    return (
      typeof parsed.decision === 'string'
      || typeof parsed.hookSpecificOutput?.permissionDecision === 'string'
      || parsed.continue === false
    )
  } catch {
    return false
  }
}
