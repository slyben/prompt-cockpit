// Pure transcript -> markdown formatter for the export route. Deliberately
// does not share code with public/stream-view.js (DOM-bound, untestable
// outside a browser) - this exists so export can be a plain node-testable
// function instead of reverse-engineering a collapsed DOM back into text.
// Rendering decisions here intentionally mirror stream-view.js's.
import { coalesceAssistantMessages } from './grok-messages.js';

const MAX_BLOCK_CHARS = 2000;
const TRUNCATED_SUFFIX = '\n… (truncated)';

function truncate(text) {
  if (typeof text !== 'string') return text;
  if (text.length <= MAX_BLOCK_CHARS) return text;
  return text.slice(0, MAX_BLOCK_CHARS) + TRUNCATED_SUFFIX;
}

// A fence needs to be longer than any run of backticks already inside the
// content, or it stops being a fence at all once rendered.
function fence(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const longestRun = (text.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  const tickCount = Math.max(3, longestRun + 1);
  const ticks = '`'.repeat(tickCount);
  return `${ticks}\n${truncate(text)}\n${ticks}`;
}

function flattenToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
  }
  return JSON.stringify(content);
}

function renderAssistantMessage(lines, message, assistantLabel) {
  const blocks = message.message && message.message.content;
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (block.type === 'text') {
      if (!block.text) continue;
      lines.push(`## ${assistantLabel}`, '', truncate(block.text), '');
    } else if (block.type === 'thinking') {
      if (!block.thinking || !block.thinking.trim()) continue;
      lines.push('<details><summary>Thinking</summary>', '', truncate(block.thinking), '', '</details>', '');
    } else if (block.type === 'tool_use') {
      lines.push(`**Tool call: ${block.name}**`, '', fence(block.input ?? {}), '');
    }
  }
}

function renderUserMessage(lines, message) {
  if (message.isSynthetic) return; // priming sentinel, not a real turn
  const content = message.message && message.message.content;
  if (typeof content === 'string') {
    lines.push('## You', '', truncate(content), '');
    return;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_result') {
        lines.push('**Tool result**', '', fence(flattenToolResultContent(block.content)), '');
      } else if (block.type === 'text' && block.text) {
        lines.push('## You', '', truncate(block.text), '');
      }
    }
  }
}

// messages: the same SDKMessage[] shape session-history.js/grok-history.js
// return (and stream-view.js renders). Returns a self-contained markdown
// string - never throws on an odd/unknown message type, it just skips it,
// same posture as stream-view.js's renderMessage default case.
export function messagesToMarkdown(messages, { title = 'Session transcript', cwd = null, sessionId = null, assistantLabel = 'Claude' } = {}) {
  const lines = [`# ${title}`, ''];
  const meta = [];
  if (cwd) meta.push(`cwd: \`${cwd}\``);
  if (sessionId) meta.push(`session: \`${sessionId}\``);
  meta.push(`exported: ${new Date().toISOString()}`);
  lines.push(meta.join('  ·  '), '');

  for (const message of coalesceAssistantMessages(messages || [])) {
    switch (message.type) {
      case 'assistant':
        renderAssistantMessage(lines, message, assistantLabel);
        break;
      case 'user':
        renderUserMessage(lines, message);
        break;
      case 'result':
        if (message.subtype !== 'success' && message.error) {
          lines.push('**Turn error**', '', truncate(message.error), '');
        }
        break;
      default:
        break; // system/rate_limit_event/etc - not part of the readable transcript
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
