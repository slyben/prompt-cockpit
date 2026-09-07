// Translate Codex app-server thread/turn/item events into the message shape
// already consumed by Prompt Cockpit's transcript renderer.

import { randomUUID } from 'node:crypto';

function assistantMessage(sessionId, content, model, usage) {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: { role: 'assistant', model: model || undefined, usage: usage || undefined, content },
  };
}

function textParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return part?.text || part?.inputText || '';
  }).filter(Boolean).join('\n');
}

function displayValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (value.text != null) return displayValue(value.text);
    if (value.inputText != null) return displayValue(value.inputText);
    if (value.content != null) {
      const content = displayValue(value.content);
      if (content) return content;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return '';
}

function outputText(item) {
  return displayValue(item?.aggregatedOutput ?? item?.output ?? item?.text ?? '');
}

function basenameForDisplay(value) {
  return String(value).split(/[\\/]/).filter(Boolean).pop() || String(value);
}

// Shared by every item type below that renders as a tool call: a paired
// tool_use/tool_result (usage.js's cost accounting ignores these; only
// assistant text/thinking blocks carry usage). A live item/started event
// emits the use and item/completed emits the matching result.
function toolCallMessages(sessionId, model, id, name, input, result, { includeUse = true } = {}) {
  const toolUse = assistantMessage(sessionId, [{ type: 'tool_use', id, name, input }], model);
  if (result == null) return includeUse ? [toolUse] : [];
  const toolResult = {
    type: 'user', session_id: sessionId, message: { role: 'user', content: [{
      type: 'tool_result', tool_use_id: id, content: result.content ?? '', is_error: Boolean(result.isError),
    }] },
  };
  return includeUse ? [toolUse, toolResult] : [toolResult];
}

function statusIsError(status) {
  return status === 'failed' || status === 'declined' || status === 'error';
}

function resultForPhase(phase, result) {
  return phase === 'started' ? null : result;
}

const ITEM_PHASES = new Set(['started', 'result-only', 'both']);

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

// The app-server's TokenUsageBreakdown.inputTokens includes its cached input
// subset. The shared Claude-shaped usage object expects input_tokens to mean
// uncached input, with cache_read_input_tokens and cache_creation_input_tokens
// kept separate for pricing. Keep the old flat/snake_case fallback because a
// few older bridges emitted the shared shape directly rather than the v2
// app-server schema.
function usageBreakdownToShared(raw, { appServerShape = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const rawInput = raw.inputTokens ?? raw.input_tokens;
  const rawOutput = raw.outputTokens ?? raw.output_tokens;
  if (rawInput == null && rawOutput == null) return null;

  const cached = numberOrZero(raw.cachedInputTokens ?? raw.cached_input_tokens
    ?? raw.inputTokensDetails?.cachedTokens ?? raw.input_tokens_details?.cached_tokens);
  const written = numberOrZero(raw.cacheWriteInputTokens ?? raw.cache_write_input_tokens
    ?? raw.inputTokensDetails?.cacheWriteTokens ?? raw.input_tokens_details?.cache_write_tokens);
  const input = numberOrZero(rawInput);

  return {
    // App-server inputTokens is total input (cached input is included), so
    // remove both separately-priced subsets before handing it to usage.js.
    input_tokens: appServerShape ? Math.max(0, input - cached - written) : input,
    output_tokens: numberOrZero(rawOutput),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
    reasoning_output_tokens: numberOrZero(raw.reasoningOutputTokens ?? raw.reasoning_output_tokens),
    total_tokens: numberOrZero(raw.totalTokens ?? raw.total_tokens),
  };
}

// In Codex's token-usage protocol, `last.totalTokens` is the latest active
// context size, while `total.totalTokens` is the cumulative session total.
// Normalize the former into the shared contextUsage shape as soon as the
// notification arrives; the registry can then treat it like any provider's
// ordinary context snapshot.
function contextUsageFromTokenUpdate(last, modelContextWindow) {
  const maxTokens = numberOrZero(modelContextWindow);
  if (!last || maxTokens <= 0) return null;
  const totalTokens = numberOrZero(last.total_tokens);
  return {
    totalTokens,
    maxTokens,
    percentage: Math.min(100, (totalTokens / maxTokens) * 100),
    // The app-server event exposes the effective window but not the current
    // auto-compact setting/threshold. Keep the bar useful and mark the
    // compact hint as unavailable rather than inventing a threshold.
    isAutoCompactEnabled: false,
    autoCompactThreshold: null,
  };
}

// v2 sends a cumulative `total` and a per-update `last`. The caller uses both:
// `last` labels this update/turn, while the top-level `_cumulativeUsage` stamp
// lets the shared accumulator add only the delta to the running session total.
function usageFromTokenUpdate(params) {
  const tokenUsage = params?.tokenUsage;
  if (tokenUsage?.last || tokenUsage?.total) {
    const last = usageBreakdownToShared(tokenUsage.last, { appServerShape: true });
    const total = usageBreakdownToShared(tokenUsage.total, { appServerShape: true });
    if (!last || !total) return null;
    return {
      last,
      total,
      contextUsage: contextUsageFromTokenUpdate(last, tokenUsage.modelContextWindow),
    };
  }

  // Compatibility with the pre-v2/bridge shape. These fields already follow
  // the shared usage convention, so cached input is not subtracted twice.
  const legacy = usageBreakdownToShared(params?.usage || params?.tokenUsage || params?.lastTokenUsage, { appServerShape: false });
  return legacy ? { last: legacy, total: null, contextUsage: null } : null;
}

export function codexItemToMessages(item, sessionId, { model, phase = 'both' } = {}) {
  if (!item || !item.type) return [];
  if (!ITEM_PHASES.has(phase)) throw new Error(`invalid Codex item phase: ${phase}`);
  const includeUse = phase !== 'result-only';
  if (item.type === 'userMessage') {
    const text = textParts(item.content);
    return text ? [{ type: 'user', session_id: sessionId, message: { role: 'user', content: text } }] : [];
  }
  if (item.type === 'agentMessage') {
    const text = item.text || textParts(item.content);
    return text ? [assistantMessage(sessionId, [{ type: 'text', text }], model)] : [];
  }
  if (item.type === 'reasoning') {
    const text = textParts(item.summary) || textParts(item.content) || item.text || '';
    return text ? [assistantMessage(sessionId, [{ type: 'thinking', thinking: text }], model)] : [];
  }
  if (item.type === 'commandExecution') {
    const id = item.id || `command-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'Bash', {
      command: item.command, cwd: item.cwd,
    }, resultForPhase(phase, {
      content: outputText(item),
      isError: item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0),
    }), { includeUse });
  }
  if (item.type === 'fileChange') {
    const id = item.id || `file-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'Edit', { changes: item.changes || [], status: item.status }, resultForPhase(phase, {
      content: item.status === 'failed' ? 'File change failed'
        : item.status === 'declined' ? 'File change declined'
        : 'File changes applied',
      isError: item.status === 'failed' || item.status === 'declined',
    }), { includeUse });
  }
  // The remaining item types render as a generic tool call - stream-view.js
  // already falls back to a plain key/value dump for any tool name it
  // doesn't specially format. `phase: 'started'` emits the pending tool
  // row; `phase: 'result-only'` emits only its result so live events do not
  // duplicate the tool use that item/started already rendered. History uses
  // `phase: 'both'` to emit a complete pair.
  if (item.type === 'mcpToolCall') {
    const id = item.id || `mcp-${randomUUID()}`;
    const name = `mcp__${item.server || 'server'}__${item.tool || 'tool'}`;
    const hasResult = item.status !== 'inProgress' && item.status != null;
    const result = hasResult ? {
      content: item.error?.message || (item.error ? displayValue(item.error) : displayValue(item.result))
        || `MCP call ${item.status}`,
      isError: statusIsError(item.status) || Boolean(item.error),
    } : null;
    return toolCallMessages(sessionId, model, id, name, item.arguments || {}, result, { includeUse });
  }
  if (item.type === 'dynamicToolCall') {
    const id = item.id || `dynamic-${randomUUID()}`;
    const hasResult = item.status !== 'inProgress' && item.status != null;
    const result = hasResult ? {
      content: Array.isArray(item.contentItems) ? textParts(item.contentItems) : `Tool call ${item.status}`,
      isError: statusIsError(item.status) || item.success === false,
    } : null;
    return toolCallMessages(sessionId, model, id, item.tool || 'Tool', item.arguments || {}, result, { includeUse });
  }
  if (item.type === 'collabAgentToolCall') {
    const id = item.id || `collab-${randomUUID()}`;
    const hasResult = item.status !== 'inProgress' && item.status != null;
    const result = hasResult ? {
      content: item.status === 'completed' ? displayValue(item.agentsStates) || 'Collaboration completed' : `Collaboration ${item.status}`,
      isError: statusIsError(item.status),
    } : null;
    return toolCallMessages(sessionId, model, id, item.tool || 'Collaborate', {
      prompt: item.prompt,
      receiverThreadIds: item.receiverThreadIds || [],
      senderThreadId: item.senderThreadId,
      model: item.model,
      reasoningEffort: item.reasoningEffort,
    }, result, { includeUse });
  }
  if (item.type === 'webSearch') {
    const id = item.id || `search-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'WebSearch', { query: item.query, action: item.action }, resultForPhase(phase, {
      content: `Search completed${item.query ? `: ${item.query}` : ''}`,
    }), { includeUse });
  }
  if (item.type === 'imageView') {
    const id = item.id || `image-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'ViewImage', { path: item.path }, resultForPhase(phase, {
      content: item.path ? `Viewed ${basenameForDisplay(item.path)}` : 'Image viewed',
    }), { includeUse });
  }
  if (item.type === 'plan') {
    const id = item.id || `plan-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'Plan', { text: item.text }, resultForPhase(phase, {
      content: item.text || 'Plan updated',
    }), { includeUse });
  }
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    const id = item.id || `review-${randomUUID()}`;
    const name = item.type === 'enteredReviewMode' ? 'EnterReviewMode' : 'ExitReviewMode';
    return toolCallMessages(sessionId, model, id, name, { review: item.review }, resultForPhase(phase, {
      content: item.type === 'enteredReviewMode' ? 'Review mode entered' : 'Review mode exited',
    }), { includeUse });
  }
  if (item.type === 'contextCompaction') {
    const id = item.id || `compaction-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'ContextCompaction', {}, resultForPhase(phase, {
      content: 'Context compaction completed',
    }), { includeUse });
  }
  if (item.type === 'hookPrompt') {
    const id = item.id || `hook-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'HookPrompt', { fragments: item.fragments || [] }, resultForPhase(phase, {
      content: 'Hook prompt completed',
    }), { includeUse });
  }
  if (item.type === 'subAgentActivity') {
    const id = item.id || `subagent-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'SubAgentActivity', {
      agentPath: item.agentPath, agentThreadId: item.agentThreadId, kind: item.kind,
    }, resultForPhase(phase, {
      content: item.kind ? `Sub-agent activity: ${item.kind}` : 'Sub-agent activity completed',
    }), { includeUse });
  }
  if (item.type === 'sleep') {
    const id = item.id || `sleep-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'Sleep', { durationMs: item.durationMs }, resultForPhase(phase, {
      content: `Slept for ${item.durationMs || 0} ms`,
    }), { includeUse });
  }
  if (item.type === 'imageGeneration') {
    const id = item.id || `image-generation-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'ImageGeneration', {
      revisedPrompt: item.revisedPrompt, savedPath: item.savedPath,
    }, resultForPhase(phase, {
      content: item.result || item.savedPath || `Image generation ${item.status || 'completed'}`,
      isError: item.status === 'failed',
    }), { includeUse });
  }
  return [];
}

export function codexNotificationToMessages(method, params, sessionId, {
  model,
  startedItemIds,
  recentStartedItemIds,
} = {}) {
  if (method === 'item/agentMessage/delta') {
    const text = params.delta || params.text || '';
    return text ? [assistantMessage(sessionId, [{ type: 'text', text }], model)] : [];
  }
  if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
    const text = params.delta || params.text || '';
    return text ? [assistantMessage(sessionId, [{ type: 'thinking', thinking: text }], model)] : [];
  }
  if (method === 'item/started') {
    const item = params.item;
    if (!item || item.type === 'userMessage' || item.type === 'agentMessage' || item.type === 'reasoning') return [];
    if (startedItemIds && item.id) startedItemIds.add(item.id);
    return codexItemToMessages(item, sessionId, { model, phase: 'started' });
  }
  if (method === 'item/completed') {
    // User input is already echoed by pushInput(), while agent text and
    // reasoning arrive through delta notifications. Re-emitting their final
    // item here duplicates the whole turn in a live transcript. Tool items do
    // not have an equivalent complete live representation, so retain those.
    const type = params.item?.type;
    if (type === 'userMessage' || type === 'agentMessage' || type === 'reasoning') return [];
    const itemId = params.item?.id;
    const wasStarted = Boolean(itemId && (startedItemIds?.delete(itemId)
      || recentStartedItemIds?.delete(itemId)));
    return codexItemToMessages(params.item, sessionId, {
      model,
      phase: wasStarted ? 'result-only' : 'both',
    });
  }
  if (method === 'thread/tokenUsage/updated') {
    // Stamping usage onto a zero-content assistant message (message.usage/
    // message.model) is what makes the stats strip/turn chart pick it up
    // without Codex-specific frontend wiring.
    const usage = usageFromTokenUpdate(params);
    if (!usage) return [];
    const message = assistantMessage(sessionId, [], model, usage.last);
    if (usage.total) message._cumulativeUsage = usage.total;
    if (usage.contextUsage) message._contextUsage = usage.contextUsage;
    return [message];
  }
  if (method === 'turn/completed') {
    const status = params.turn?.status || params.status || 'completed';
    const ok = status === 'completed' || status === 'interrupted';
    return [{
      type: 'result', subtype: ok ? 'success' : 'error', is_error: !ok,
      session_id: sessionId, num_turns: 1, stop_reason: status, result: '',
      error: ok ? undefined : (params.turn?.error?.message || 'Codex turn failed'),
    }];
  }
  return [];
}

// thread.model here reads as undefined on a real app-server response - the
// documented Thread schema has no model field (see codex-history.js's
// listCodexSessions for the same gap) - so a rendered history's assistant
// messages carry no model label until/unless a future app-server version
// adds one. Left in as a harmless no-op rather than removed.
export function codexThreadToMessages(thread) {
  const messages = [];
  for (const turn of thread?.turns || []) {
    for (const item of turn?.items || []) {
      messages.push(...codexItemToMessages(item, thread.id, { model: thread.model, phase: 'both' }));
    }
    if (turn?.status === 'failed') {
      messages.push(...codexNotificationToMessages('turn/completed', { turn }, thread.id, { model: thread.model }));
    }
  }
  return messages;
}
