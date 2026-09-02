// Pure transform between the SDK's raw getContextUsage() response and the
// { autoCompact } shape the client renders. autoCompactThreshold's units
// relative to `percentage`'s 0-100 scale are undocumented, so this tries
// plausible encodings (fraction, percent, absolute tokens) and falls back
// to the cockpit's long-standing 80% assumption when none fit.

export const DEFAULT_COMPACT_WARN_PERCENT = 80;

// A real auto-compact trigger below half the context window is implausible
// for any model in use today - this band is what stops a mis-scaled value
// (e.g. a fraction misread as a raw token count) from firing constantly or
// never firing at all.
const PLAUSIBLE_MIN = 50;
const PLAUSIBLE_MAX = 99;

let warnedOnce = false;

// Tries, in order: fraction (0-1], percent (1-100], absolute token count
// (>100, using maxTokens to convert to a percentage). Returns a 0-100
// percentage, or null if the value is missing, non-finite, or lands
// outside the plausibility band under every interpretation tried.
export function normalizeAutoCompactThreshold(contextUsage, { warn = defaultWarn } = {}) {
  if (!contextUsage) return null;
  const raw = contextUsage.autoCompactThreshold;
  const maxTokens = contextUsage.maxTokens;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;

  let pct;
  if (raw <= 1) {
    pct = raw * 100;
  } else if (raw <= 100) {
    pct = raw;
  } else if (typeof maxTokens === 'number' && maxTokens > 0) {
    pct = (raw / maxTokens) * 100;
  } else {
    pct = null;
  }

  if (pct === null || pct < PLAUSIBLE_MIN || pct > PLAUSIBLE_MAX) {
    warn(raw, maxTokens);
    return null;
  }
  return pct;
}

function defaultWarn(raw, maxTokens) {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(
    `autoCompactThreshold (${raw}, maxTokens ${maxTokens}) didn't fit any plausible unit interpretation - ` +
    `falling back to the assumed ${DEFAULT_COMPACT_WARN_PERCENT}% for this process. If this value is real, ` +
    'context-usage.js needs its plausibility band or unit sniffing updated.'
  );
}

// Reset for tests only - the module-level warn latch would otherwise leak
// across test cases in the same process.
export function _resetWarnedOnceForTests() {
  warnedOnce = false;
}

// Shared by session-registry.js's usagePayload - the shape forwarded to
// the client over cockpit:usage.
export function contextPayload(contextUsage) {
  if (!contextUsage) return null;
  const normalized = normalizeAutoCompactThreshold(contextUsage);
  return {
    totalTokens: contextUsage.totalTokens,
    maxTokens: contextUsage.maxTokens,
    percentage: contextUsage.percentage,
    autoCompact: {
      enabled: Boolean(contextUsage.isAutoCompactEnabled),
      warnPercent: normalized ?? DEFAULT_COMPACT_WARN_PERCENT,
      source: normalized !== null ? 'sdk' : 'fallback',
    },
  };
}
