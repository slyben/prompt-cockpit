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
  return content.map((part) => part?.text || part?.inputText || '').filter(Boolean).join('\n');
}

function outputText(item) {
  return item?.aggregatedOutput || item?.output || item?.text || '';
}

// Shared by every item type below that renders as a tool call: a paired
// tool_use/tool_result (usage.js's cost accounting ignores these; only
// assistant text/thinking blocks carry usage). `result` omitted means no
// tool_result is emitted (webSearch, imageView, plan, and review-mode
// markers have no completion/output field in the app-server's schema).
function toolCallMessages(sessionId, model, id, name, input, result) {
  const toolUse = assistantMessage(sessionId, [{ type: 'tool_use', id, name, input }], model);
  if (!result) return [toolUse];
  return [
    toolUse,
    {
      type: 'user', session_id: sessionId, message: { role: 'user', content: [{
        type: 'tool_result', tool_use_id: id, content: result.content ?? '', is_error: Boolean(result.isError),
      }] },
    },
  ];
}

function statusIsError(status) {
  return status === 'failed' || status === 'declined' || status === 'error';
}

// See the NOTE at this function's only call site (thread/tokenUsage/updated,
// below) - field names here are a best-effort guess, not a confirmed schema.
function usageFromTokenUpdate(params) {
  const u = params?.usage || params?.tokenUsage || params?.lastTokenUsage || {};
  const input = u.input_tokens ?? u.inputTokens;
  const output = u.output_tokens ?? u.outputTokens;
  if (input == null && output == null) return null;
  const details = u.input_tokens_details || u.inputTokensDetails || {};
  const cached = u.cached_input_tokens ?? u.cachedInputTokens
    ?? details.cached_tokens ?? details.cachedTokens ?? 0;
  return {
    input_tokens: input || 0,
    output_tokens: output || 0,
    cache_read_input_tokens: cached || 0,
    cache_creation_input_tokens: 0,
  };
}

export function codexItemToMessages(item, sessionId, { model } = {}) {
  if (!item || !item.type) return [];
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
    return [
      assistantMessage(sessionId, [{
        type: 'tool_use', id, name: 'Bash', input: { command: item.command, cwd: item.cwd },
      }], model),
      {
        type: 'user', session_id: sessionId, message: { role: 'user', content: [{
          type: 'tool_result', tool_use_id: id, content: outputText(item),
          is_error: item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0),
        }] },
      },
    ];
  }
  if (item.type === 'fileChange') {
    const id = item.id || `file-${randomUUID()}`;
    return [
      assistantMessage(sessionId, [{
        type: 'tool_use', id, name: 'Edit', input: { changes: item.changes || [] },
      }], model),
      {
        type: 'user', session_id: sessionId, message: { role: 'user', content: [{
          type: 'tool_result', tool_use_id: id,
          content: item.status === 'failed' ? 'File change failed'
            : item.status === 'declined' ? 'File change declined'
            : 'File changes applied',
          is_error: item.status === 'failed' || item.status === 'declined',
        }] },
      },
    ];
  }
  // The remaining item types render as a generic tool call - stream-view.js
  // already falls back to a plain key/value dump for any tool name it
  // doesn't specially format, so no frontend changes are needed here.
  if (item.type === 'mcpToolCall') {
    const id = item.id || `mcp-${randomUUID()}`;
    const name = `mcp__${item.server || 'server'}__${item.tool || 'tool'}`;
    const hasResult = item.status !== 'inProgress' && item.status != null;
    return toolCallMessages(sessionId, model, id, name, item.arguments || {}, hasResult ? {
      content: item.error ? String(item.error) : outputText({ output: item.result }),
      isError: statusIsError(item.status) || Boolean(item.error),
    } : null);
  }
  if (item.type === 'dynamicToolCall') {
    const id = item.id || `dynamic-${randomUUID()}`;
    const hasResult = item.status !== 'inProgress' && item.status != null;
    return toolCallMessages(sessionId, model, id, item.tool || 'Tool', item.arguments || {}, hasResult ? {
      content: Array.isArray(item.contentItems) ? textParts(item.contentItems) : '',
      isError: statusIsError(item.status) || item.success === false,
    } : null);
  }
  if (item.type === 'collabToolCall') {
    const id = item.id || `collab-${randomUUID()}`;
    const hasResult = item.status !== 'inProgress' && item.status != null;
    return toolCallMessages(sessionId, model, id, item.tool || 'Collaborate', {
      prompt: item.prompt, receiverThreadId: item.receiverThreadId, newThreadId: item.newThreadId,
    }, hasResult ? { content: item.agentStatus || '', isError: statusIsError(item.status) } : null);
  }
  if (item.type === 'webSearch') {
    const id = item.id || `search-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'WebSearch', { query: item.query, action: item.action });
  }
  if (item.type === 'imageView') {
    const id = item.id || `image-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'ViewImage', { path: item.path });
  }
  if (item.type === 'plan') {
    const id = item.id || `plan-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'Plan', { text: item.text });
  }
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    const id = item.id || `review-${randomUUID()}`;
    const name = item.type === 'enteredReviewMode' ? 'EnterReviewMode' : 'ExitReviewMode';
    return toolCallMessages(sessionId, model, id, name, { review: item.review });
  }
  if (item.type === 'contextCompaction') {
    const id = item.id || `compaction-${randomUUID()}`;
    return toolCallMessages(sessionId, model, id, 'ContextCompaction', {});
  }
  return [];
}

export function codexNotificationToMessages(method, params, sessionId, { model } = {}) {
  if (method === 'item/agentMessage/delta') {
    const text = params.delta || params.text || '';
    return text ? [assistantMessage(sessionId, [{ type: 'text', text }], model)] : [];
  }
  if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
    const text = params.delta || params.text || '';
    return text ? [assistantMessage(sessionId, [{ type: 'thinking', thinking: text }], model)] : [];
  }
  if (method === 'item/completed') {
    // User input is already echoed by pushInput(), while agent text and
    // reasoning arrive through delta notifications. Re-emitting their final
    // item here duplicates the whole turn in a live transcript. Tool items do
    // not have an equivalent complete live representation, so retain those.
    const type = params.item?.type;
    if (type === 'userMessage' || type === 'agentMessage' || type === 'reasoning') return [];
    return codexItemToMessages(params.item, sessionId, { model });
  }
  if (method === 'thread/tokenUsage/updated') {
    // Stamping usage onto a zero-content assistant message (message.usage/
    // message.model) is what makes the stats strip/turn chart pick it up
    // for free. The app-server doesn't publish this notification's exact
    // field names, so usageFromTokenUpdate() reads every plausible spelling
    // variant - unverified against a live app-server response.
    const usage = usageFromTokenUpdate(params);
    return usage ? [assistantMessage(sessionId, [], model, usage)] : [];
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
    for (const item of turn?.items || []) messages.push(...codexItemToMessages(item, thread.id, { model: thread.model }));
    if (turn?.status === 'failed') {
      messages.push(...codexNotificationToMessages('turn/completed', { turn }, thread.id, { model: thread.model }));
    }
  }
  return messages;
}
