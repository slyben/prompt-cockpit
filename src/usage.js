// Cost/token accounting for MVP4's live stats panel. Cost math is ported
// verbatim from claude-realtime-usage/live_watcher_template.html's
// stepCost() (itself mirroring that project's parse.py cost_for_usage()) -
// same pricing table, same formula, so the two tools agree on a dollar
// figure for the same session. Claude rates live in pricing.json (a copy
// of the claude-realtime-usage table). Grok rates live in pricing_grok.json
// so the two catalogs cannot clobber each other.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadModels(filename) {
  return JSON.parse(readFileSync(path.join(__dirname, filename), 'utf8')).models;
}

const CLAUDE_PRICING = loadModels('pricing.json');
const GROK_PRICING = loadModels('pricing_grok.json');

function ratesFor(model) {
  if (model && Object.prototype.hasOwnProperty.call(GROK_PRICING, model)) return GROK_PRICING[model];
  if (model && Object.prototype.hasOwnProperty.call(CLAUDE_PRICING, model)) return CLAUDE_PRICING[model];
  return null;
}

// usage: a BetaMessage.usage object off the live SDK stream (assistant
// message) - same shape as the persisted transcript's `.message.usage`,
// which is what makes this formula reusable for the history pane too.
// Returns null for a model with no pricing entry (unknown/new model) rather
// than guessing - callers show $0 and flag it, same as the reference tool.
const USD_TICKS = 10_000_000_000; // Grok stamps cost in ticks: 1 USD = 10^10

export function costForUsage(model, usage) {
  if (!usage) return null;

  const cc = usage.cache_creation || {};
  let write5m = cc.ephemeral_5m_input_tokens || 0;
  const write1h = cc.ephemeral_1h_input_tokens || 0;
  if (!usage.cache_creation && usage.cache_creation_input_tokens) write5m = usage.cache_creation_input_tokens;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const writeTokens = write5m + write1h;

  const stamped = stampedCostUsd(usage);
  if (stamped != null) {
    return { cost: stamped, inputTokens: input, outputTokens: output, writeTokens, readTokens: read };
  }

  const rates = ratesFor(model);
  if (!rates) return null;

  const cost = (input * rates.input + output * rates.output +
    write5m * rates.cache_write_5m + write1h * rates.cache_write_1h + read * rates.cache_read) / 1e6;

  return { cost, inputTokens: input, outputTokens: output, writeTokens, readTokens: read };
}

function stampedCostUsd(usage) {
  if (Number.isFinite(usage.cost_usd)) return usage.cost_usd;
  if (Number.isFinite(usage.total_cost_usd)) return usage.total_cost_usd;
  const ticks = usage.cost_usd_ticks ?? usage.costUsdTicks;
  if (Number.isFinite(ticks)) return ticks / USD_TICKS;
  return null;
}

// Running totals for one session, updated as assistant messages arrive on
// the live stream (session-registry.js's handleMessage) - no 1-turn lag,
// per plan MVP4. `unpriced` collects any model id missing from both
// pricing files so the panel can flag "cost may be understated" instead of
// silently under-reporting.
export function createUsageAccumulator() {
  const totals = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const unpriced = new Set();

  return {
    totals,
    unpriced,
    // Call with an SDKAssistantMessage's `.message` (a BetaMessage) - a
    // no-op if it has no usage (shouldn't happen for a real assistant
    // turn, but priming-sentinel/synthetic messages have none).
    addAssistantMessage(message) {
      if (!message || !message.usage) return;
      const info = costForUsage(message.model, message.usage);
      if (!info) {
        if (message.model) unpriced.add(message.model);
        return;
      }
      totals.costUsd += info.cost;
      totals.inputTokens += info.inputTokens;
      totals.outputTokens += info.outputTokens;
      totals.cacheReadTokens += info.readTokens;
      totals.cacheWriteTokens += info.writeTokens;
    },
    snapshot() {
      const cacheTotal = totals.cacheReadTokens + totals.cacheWriteTokens;
      return {
        ...totals,
        cacheHitRate: cacheTotal > 0 ? totals.cacheReadTokens / cacheTotal : null,
        unpriced: [...unpriced],
      };
    },
  };
}
