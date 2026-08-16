// Turn ACP session/update payloads into the Claude-shaped sdk:message
// objects stream-view.js already knows how to render.

function textFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (typeof content.text === 'string') return content.text;
  return '';
}

function flattenToolOutput(update) {
  if (update.rawOutput != null) {
    if (typeof update.rawOutput === 'string') return update.rawOutput;
    try {
      return JSON.stringify(update.rawOutput, null, 2);
    } catch {
      return String(update.rawOutput);
    }
  }
  if (!Array.isArray(update.content)) return '';
  const parts = [];
  for (const item of update.content) {
    if (item.type === 'content' && item.content) {
      const text = textFromContent(item.content);
      if (text) parts.push(text);
    } else if (item.type === 'diff') {
      const path = item.path || '';
      parts.push(`${path}\n---\n${item.oldText ?? ''}\n+++\n${item.newText ?? ''}`);
    } else if (item.type === 'text') {
      if (item.text) parts.push(item.text);
    }
  }
  return parts.join('\n');
}

function toolName(update) {
  return update.toolName || update.title || 'tool';
}

function assistantMessage(sessionId, content, { model, usage } = {}) {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      model: model || undefined,
      usage: usage || undefined,
      content,
    },
  };
}

function usageFromUpdate(update) {
  const u = update.usage || {};
  const input = u.input_tokens ?? u.inputTokens;
  const output = u.output_tokens ?? u.outputTokens;
  if (input == null && output == null && u.costUsdTicks == null && u.cost_usd == null) return null;
  return {
    input_tokens: input || 0,
    output_tokens: output || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || u.cacheReadInputTokens || u.cachedReadTokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || u.cacheCreationInputTokens || u.cacheCreationTokens || 0,
    cost_usd_ticks: u.costUsdTicks ?? u.cost_usd_ticks,
    cost_usd: u.costUSD ?? u.costUsd ?? u.cost_usd ?? u.total_cost_usd,
  };
}

export function acpUpdateToMessages(update, sessionId, { model } = {}) {
  if (!update || !update.sessionUpdate) return [];
  const kind = update.sessionUpdate;

  // Grok only stamps a bill on turn_completed (confirmed against real
  // updates.jsonl). usage / usage_update are ACP names this agent does not
  // emit; treating them as bills would double-count if they ever appear
  // alongside the final turn_completed.
  if (kind === 'turn_completed') {
    const usage = usageFromUpdate(update);
    if (!usage) return [];
    return [assistantMessage(sessionId, [], { model, usage })];
  }

  if (kind === 'agent_message_chunk') {
    const text = textFromContent(update.content);
    if (!text) return [];
    return [assistantMessage(sessionId, [{ type: 'text', text }], { model })];
  }

  if (kind === 'agent_thought_chunk') {
    const text = textFromContent(update.content);
    if (!text) return [];
    return [assistantMessage(sessionId, [{ type: 'thinking', thinking: text }], { model })];
  }

  if (kind === 'user_message_chunk') {
    const text = textFromContent(update.content);
    if (!text) return [];
    return [{
      type: 'user',
      session_id: sessionId,
      message: { role: 'user', content: text },
    }];
  }

  if (kind === 'tool_call') {
    return [assistantMessage(sessionId, [{
      type: 'tool_use',
      id: update.toolCallId,
      name: toolName(update),
      input: update.rawInput || {},
    }], { model })];
  }

  if (kind === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) {
    return [{
      type: 'user',
      session_id: sessionId,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: update.toolCallId,
          content: flattenToolOutput(update),
          is_error: update.status === 'failed',
        }],
      },
    }];
  }

  return [];
}

export function turnResultMessage(sessionId, stopReason) {
  const ok = stopReason === 'end_turn' || stopReason === 'cancelled';
  return {
    type: 'result',
    subtype: ok ? 'success' : 'error',
    is_error: !ok,
    session_id: sessionId,
    num_turns: 1,
    stop_reason: stopReason || 'end_turn',
    result: '',
    error: ok ? undefined : (stopReason || 'turn ended'),
  };
}

export function pickPermissionOption(options, allow) {
  const list = Array.isArray(options) ? options : [];
  const wanted = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const found = list.find((opt) => wanted.includes(opt.kind));
  return found ? found.optionId : null;
}

const READ_KINDS = new Set(['read', 'search', 'think', 'fetch']);

// Grok has no server-side acceptEdits/plan policy. Decide here, fail closed.
export function grokPermissionAction(mode, toolCall) {
  const kind = toolCall && toolCall.kind;
  if (mode === 'bypassPermissions') return 'allow';
  if (mode === 'acceptEdits') return kind === 'edit' ? 'allow' : 'ask';
  if (mode === 'plan') return READ_KINDS.has(kind) ? 'allow' : 'deny';
  return 'ask';
}
