// MVP4 live stats strip: cost, tokens, cache hit rate, context percentage.
// Fed by the server's `cockpit:usage` message (session-registry.js), sent on
// every assistant message (cost/tokens) and after every finished turn
// (context percentage, which is its own round trip to the CLI). Formatters
// mirror claude-realtime-usage/live_watcher_template.html's fmtUSD/fmtTok so
// the two tools read the same at a glance.
export function initStatsPanel({ el }) {
  reset();

  function fmtUSD(v) {
    if (v > 0 && v < 0.01) return '$' + v.toFixed(4);
    return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtTok(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(v);
  }

  // statusline-command.py's fmt_k: whole-number K/M, no decimal - matched
  // here so the context bar's "38K/200K" reads identically to the
  // statusline's own, not just similarly.
  function fmtTokWhole(v) {
    if (v >= 1e6) return Math.round(v / 1e6) + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'K';
    return String(v);
  }

  function update(usage, context, rateLimits) {
    if (!usage) return;
    const inTok = usage.inputTokens || 0;
    const outTok = usage.outputTokens || 0;
    const cacheTok = (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
    const hitRate = usage.cacheHitRate;

    const parts = [
      `<span class="stat-cost" title="Session cost so far, from the live message stream">${fmtUSD(usage.costUsd)}</span>`,
      `<span title="Tokens in / out">${fmtTok(inTok)} in · ${fmtTok(outTok)} out</span>`,
    ];
    if (cacheTok > 0) {
      const pct = hitRate == null ? '' : ` (${Math.round(hitRate * 100)}% hit)`;
      parts.push(`<span title="Cache read+write tokens, and read-vs-write hit rate">${fmtTok(cacheTok)} cache${pct}</span>`);
    }
    if (usage.perTool && usage.perTool.length) {
      parts.push(perToolChip(usage.perTool));
    }
    if (context) {
      parts.push(contextBar(context));
    }
    if (usage.unpriced && usage.unpriced.length) {
      parts.push(`<span class="stat-warn" title="No pricing entry for: ${usage.unpriced.join(', ')} - cost shown may be understated">⚠ unpriced model</span>`);
    }
    // Best-effort plan quota, off the SDK's experimental usage API
    // (session-registry.js's refreshRateLimits) - absent entirely on API
    // key/Bedrock/Vertex sessions, and permanently absent for this process
    // if that API ever breaks, in which case `rateLimits` is just always
    // null and this chip never appears. Cost/token/context chips above
    // don't depend on it either way.
    const fiveHour = rateLimits && rateLimits.five_hour;
    if (fiveHour && fiveHour.utilization != null) {
      // resets_at is the SDK's own ISO timestamp for when this window
      // clears - was already on the wire (rate_limits.five_hour.resets_at)
      // but never read here, so the chip showed utilization with no way to
      // tell when it's actually finishing. toLocaleTimeString to match the
      // rate-limit-hit banner's own clock format (app.js's showApprovalRequest
      // neighbor, the `when` local in the rate-limit-hit renderer).
      const resetLabel = fiveHour.resets_at
        ? ` (resets ${new Date(fiveHour.resets_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
        : '';
      parts.push(`<span title="Plan 5-hour window utilization">${Math.round(fiveHour.utilization)}% 5h${resetLabel}</span>`);
    }
    el.innerHTML = parts.join('<span class="stat-sep">·</span>');
    el.style.display = 'flex';
  }

  // Same shape as ~/.claude/statusline-command.py's context segment: a
  // 10-cell `[####------] 38K/200K` bar, colored relative to
  // context.autoCompact.warnPercent (src/context-usage.js - the SDK's real
  // auto-compact threshold when confirmed plausible, else the same 80%
  // this used to hardcode as `remaining < 20`). Yellow starts 30 points
  // before red, preserving the original 50/80 relationship when warn===80.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Turn cost is only reported per assistant message by the API - there's
  // no per-tool-call usage - so usage.perTool (usage.js's accumulator)
  // splits each turn's cost evenly across the tool_use blocks it contains.
  // Shown as a tooltip (matches this panel's existing chips - no popover
  // CSS in this codebase) rather than a click-to-expand row, since it's
  // supplementary detail, not something read at a glance like cost/tokens.
  function perToolChip(perTool) {
    const lines = perTool
      .slice(0, 8)
      .map((t) => `${t.name}: ${fmtUSD(t.costUsd)} (${t.calls}×)`)
      .join('\n');
    const title = `Cost per tool - turn cost split evenly across tools used in that turn (approximation, not a true per-call figure):\n${lines}`;
    return `<span title="${escapeHtml(title)}">${perTool.length} tool${perTool.length === 1 ? '' : 's'}</span>`;
  }

  function contextBar(context) {
    const pct = context.percentage || 0;
    const warnPercent = context.autoCompact?.warnPercent ?? 80;
    const filled = Math.min(10, Math.max(0, Math.round(pct / 10)));
    const bar = '[' + '#'.repeat(filled) + '-'.repeat(10 - filled) + ']';
    const colorClass = pct >= warnPercent ? 'ctx-red' : pct >= warnPercent - 30 ? 'ctx-yellow' : 'ctx-green';
    const used = fmtTokWhole(context.totalTokens || 0);
    const total = fmtTokWhole(context.maxTokens || 0);
    return `<span class="${colorClass}" title="Context window used">${bar} ${used}/${total}</span>`;
  }

  function reset() {
    el.innerHTML = '';
    el.style.display = 'none';
  }

  return { update, reset };
}
