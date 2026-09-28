// Per-model rules for the Claude thinking controls, shared verbatim between
// server (route validation) and browser (dropdown state). Pure functions, no
// I/O. Unknown or not-yet-resolved models get the permissive legacy rules so a
// new model id never locks a control out.
//
// off:
//   'always'     - Off works at any effort.
//   'atMostHigh' - Off works only at low/medium/high. Verified live on
//                  claude-sonnet-5-5: at xhigh the request succeeds but
//                  thinking stays on (Off is silently ignored).
//   'never'      - thinking cannot be turned off; lower the effort instead.
// sizedBudgets: whether 4k/10k/32k mean anything. On Opus 4.7+/5.x, Sonnet 5.x
// and Fable/Mythos any nonzero value just means "adaptive on".

const ALWAYS_SIZED = Object.freeze({ off: 'always', sizedBudgets: true });
const ALWAYS_UNSIZED = Object.freeze({ off: 'always', sizedBudgets: false });
const AT_MOST_HIGH = Object.freeze({ off: 'atMostHigh', sizedBudgets: false });
const NEVER = Object.freeze({ off: 'never', sizedBudgets: false });

const OFF_OK_EFFORTS = new Set(['low', 'medium', 'high']);
const DEFAULT_EFFORT = 'high';

// 'anthropic.claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', 'claude-haiku-4-5-20251001',
// 'claude-opus-4-5@20251101' all reduce to their bare family id.
function normalizeModel(model) {
  if (typeof model !== 'string') return '';
  return model
    .toLowerCase()
    .replace(/^anthropic\./, '')
    .replace(/\[.*\]$/, '')
    .replace(/@.*$/, '')
    .replace(/-\d{8}$/, '');
}

export function thinkingRulesFor(model) {
  const id = normalizeModel(model);
  if (/^claude-(fable|mythos)-5/.test(id)) return NEVER;
  if (id === 'claude-opus-5-5') return NEVER;
  if (id === 'claude-opus-5' || id === 'claude-sonnet-5-5') return AT_MOST_HIGH;
  if (id === 'claude-sonnet-5' || id === 'claude-opus-4-8' || id === 'claude-opus-4-7') return ALWAYS_UNSIZED;
  return ALWAYS_SIZED;
}

// Why Off can't be chosen right now, or null when it can. `effort` unset means
// the SDK default ('high').
export function offBlockedReason(model, effort) {
  const rules = thinkingRulesFor(model);
  if (rules.off === 'never') {
    return 'This model always thinks - lower the effort to spend less on thinking.';
  }
  if (rules.off === 'atMostHigh' && !OFF_OK_EFFORTS.has(effort || DEFAULT_EFFORT)) {
    return 'Off is ignored at Extra high / Max effort on this model - pick High or lower first.';
  }
  return null;
}

// Why `effort` can't be chosen while Off (maxThinkingTokens === 0) is set, or
// null when it can - the mirror of offBlockedReason.
export function effortBlockedByOffReason(model, effort, maxThinkingTokens) {
  if (maxThinkingTokens !== 0) return null;
  if (thinkingRulesFor(model).off !== 'atMostHigh') return null;
  return OFF_OK_EFFORTS.has(effort) || !effort
    ? null
    : 'Thinking is Off, and Off is ignored at this effort on this model - set thinking to Default first.';
}
