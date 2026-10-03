// Landing-page quotas use the same structured /usage API as live sessions.
// A synthetic, zero-turn prompt initializes the CLI without a model request.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { tmpdir } from 'node:os';
import { claudeSubscriptionEnv, resolveClaudeSubscription } from './claude-subscriptions.js';
import { accountUsageCache } from './account-usage-cache.js';

export function claudeAccountUsageKey({ subscription } = {}) {
  return `claude:${resolveClaudeSubscription(subscription).configDir}`;
}

export async function readClaudeAccountLimits(queryHandle) {
  const usage = await queryHandle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  return usage.rate_limits_available ? usage.rate_limits : null;
}

async function* quotaPrompt() {
  yield {
    type: 'user',
    message: { role: 'user', content: '' },
    parent_tool_use_id: null,
    shouldQuery: false,
    isSynthetic: true,
  };
  await new Promise(() => {});
}

export async function fetchClaudeRateLimits({ subscription, queryHandle, queryImpl = query, timeoutMs = 20_000, refresh = false } = {}) {
  return accountUsageCache.fetch(claudeAccountUsageKey({ subscription }), async () => {
    if (!queryHandle) return readRateLimits(queryImpl, subscription, timeoutMs);
    return readClaudeAccountLimits(queryHandle);
  }, { refresh });
}

async function readRateLimits(queryImpl, subscription, timeoutMs) {
  const abortController = new AbortController();
  const handle = queryImpl({
    prompt: quotaPrompt(),
    options: {
      cwd: tmpdir(),
      env: claudeSubscriptionEnv(subscription),
      settingSources: [],
      persistSession: false,
      abortController,
    },
  });
  let timer;
  try {
    const read = async () => {
      if (!handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) return null;
      for await (const message of handle) {
        if (message.type === 'result' && message.num_turns === 0) {
          return readClaudeAccountLimits(handle);
        }
      }
      throw new Error('Claude CLI closed before completing its usage lookup');
    };
    const rateLimits = await Promise.race([
      read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Claude usage lookup timed out')), timeoutMs);
      }),
    ]);
    return rateLimits;
  } finally {
    clearTimeout(timer);
    abortController.abort();
    handle.close();
  }
}

export function _resetCacheForTests() {
  accountUsageCache.clear();
}
