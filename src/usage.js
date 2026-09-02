// Cost/token accounting for the live stats panel. Claude rates live in
// pricing.json, Grok in pricing_grok.json, Codex in pricing_codex.json,
// kept as separate catalogs so they cannot clobber each other.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadModels(filename) {
  return JSON.parse(readFileSync(path.join(__dirname, filename), 'utf8')).models;
}

const CLAUDE_PRICING = loadModels('pricing.json');
const GROK_PRICING = loadModels('pricing_grok.json');
const CODEX_PRICING = loadModels('pricing_codex.json');

function ratesFor(model) {
  if (model && Object.prototype.hasOwnProperty.call(GROK_PRICING, model)) return GROK_PRICING[model];
  if (model && Object.prototype.hasOwnProperty.call(CODEX_PRICING, model)) return CODEX_PRICING[model];
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
  // No pricing entry: still return the real token breakdown (an unpriced
  // model shouldn't zero out someone's token counters, only its cost - see
  // createUsageAccumulator's addAssistantMessage and session-registry.js's
  // applyAssistantUsage, both of which key off `cost === null` now instead
  // of treating "no rates" as "nothing to report").
  if (!rates) return { cost: null, inputTokens: input, outputTokens: output, writeTokens, readTokens: read };

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
// the live stream (session-registry.js's handleMessage) - no 1-turn lag.
// `unpriced` collects any model id missing from both
// pricing files so the panel can flag "cost may be understated" instead of
// silently under-reporting.
const NO_TOOL_BUCKET = '(no tool call)';

export function createUsageAccumulator() {
  const totals = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const unpriced = new Set();
  // name -> { costUsd, calls, inputTokens, outputTokens, cacheReadTokens,
  //   cacheWriteTokens }. The SDK reports cost/tokens per turn, not per
  // tool call, so a turn with N tool_use blocks has its cost split evenly
  // across those N buckets - this keeps sum(perTool.costUsd) ===
  // totals.costUsd exactly. Turns with no tool_use land in NO_TOOL_BUCKET.
  const perTool = new Map();

  function addToolBucket(name, info, n) {
    const b = perTool.get(name) || { name, costUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    b.costUsd += info.cost / n;
    b.calls += 1;
    b.inputTokens += info.inputTokens / n;
    b.outputTokens += info.outputTokens / n;
    b.cacheReadTokens += info.readTokens / n;
    b.cacheWriteTokens += info.writeTokens / n;
    perTool.set(name, b);
  }

  return {
    totals,
    unpriced,
    // Call with an SDKAssistantMessage's `.message` (a BetaMessage) - a
    // no-op if it has no usage (shouldn't happen for a real assistant
    // turn, but priming-sentinel/synthetic messages have none). `toolNames`
    // is the list of tool_use block names this turn produced (duplicates
    // included), read from that same `.message.content` by the caller.
    addAssistantMessage(message, toolNames = []) {
      if (!message || !message.usage) return;
      const info = costForUsage(message.model, message.usage);
      if (!info) return; // no usage - already ruled out above, kept as a guard
      // Tokens accumulate regardless of whether this model priced (B1) - only
      // the cost line is skipped, with the model flagged in `unpriced` so the
      // panel can show "$0.00 (understated)" instead of silently costing a
      // real turn at zero. Previously the whole message was dropped here,
      // which also zeroed its token counts - see usage.js's costForUsage.
      if (info.cost == null) {
        if (message.model) unpriced.add(message.model);
      } else {
        totals.costUsd += info.cost;
      }
      totals.inputTokens += info.inputTokens;
      totals.outputTokens += info.outputTokens;
      totals.cacheReadTokens += info.readTokens;
      totals.cacheWriteTokens += info.writeTokens;

      // Tool buckets split cost the same "even across this turn's tool_use
      // blocks" way regardless of pricing - an unpriced turn's buckets just
      // carry a 0 cost contribution, same total-tokens invariant as before.
      const bucketInfo = info.cost == null ? { ...info, cost: 0 } : info;
      if (toolNames.length === 0) {
        addToolBucket(NO_TOOL_BUCKET, bucketInfo, 1);
      } else {
        for (const name of toolNames) addToolBucket(name, bucketInfo, toolNames.length);
      }
    },
    snapshot() {
      const cacheTotal = totals.cacheReadTokens + totals.cacheWriteTokens;
      const perToolList = [...perTool.values()].sort((a, b) => b.costUsd - a.costUsd);
      return {
        ...totals,
        perTool: perToolList,
        cacheHitRate: cacheTotal > 0 ? totals.cacheReadTokens / cacheTotal : null,
        unpriced: [...unpriced],
      };
    },
  };
}
