// Backfills a resumed session's transcript so the client sees the full
// conversation immediately, not just new activity from this point forward.
// Separate from rewind.js's resolveTurnUuid (also built on
// getSessionMessages) - this is about the resume flow, not rewind
// targeting, even though both read the same underlying transcript.
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { isSafeSessionId } from './safe-id.js';

const MAX_HISTORY_MESSAGES = 5000; // safety cap against a pathologically long session, not a UX truncation

// Sized in tokens, not message count: message size varies wildly (a one-line
// reply vs. a huge tool_result dump), so a fixed message count under- or
// over-shoots badly. Long sessions get a fast initial paint plus a "Load
// earlier history" button for the rest, refetched on demand rather than
// cached.
export const INITIAL_HISTORY_TOKEN_BUDGET = 1_000_000;

const CHARS_PER_TOKEN_ESTIMATE = 4; // no real tokenizer available for persisted transcript messages

export async function fetchSessionHistory(claudeSessionId, cwd) {
  // Guard against a crafted id (e.g. `../../../etc/passwd`, or a
  // URL-decoded `..%2F..%2F..`) reaching getSessionMessages, which has no
  // validation of its own - see safe-id.js's comment for the incident this
  // closed.
  if (!isSafeSessionId(claudeSessionId)) throw new Error(`invalid session id: ${claudeSessionId}`);
  const messages = await getSessionMessages(claudeSessionId, { dir: cwd, limit: MAX_HISTORY_MESSAGES });
  return messages.filter(isRenderable);
}

// Walks from the end of `messages` backward, accumulating a rough token
// estimate, and returns how many trailing messages fit within `budget`.
// Always includes at least the most recent message, even if it alone
// exceeds budget (a single huge tool_result shouldn't produce an empty
// initial view).
export function countWithinTokenBudget(messages, budget) {
  let used = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(messages[i]);
    if (count > 0 && used + cost > budget) break;
    used += cost;
    count += 1;
  }
  return count;
}

function estimateTokens(message) {
  try {
    return Math.ceil(JSON.stringify(message).length / CHARS_PER_TOKEN_ESTIMATE);
  } catch {
    return 0;
  }
}

// Drops session.js's priming-sentinel entries. They persist as isMeta
// entries wrapped as "[MESSAGE FROM NON-USER SOURCE...]" (confirmed live -
// see src/session-launcher.js's scanTranscript, which hits the same
// thing). `SessionMessage` doesn't expose `isMeta` on its own shape, only
// inside the opaque `message` field, so match on the wrapper text instead.
function isRenderable(m) {
  if (m.type !== 'user') return true;
  const content = m.message && m.message.content;
  if (isSentinel(content)) return false;
  return true;
}

function isSentinel(content) {
  return typeof content === 'string' && content.startsWith('[MESSAGE FROM NON-USER SOURCE');
}

// Real user-authored turns only - `type: 'user'` entries that are neither
// the priming sentinel nor a tool_result (those have array content, not a
// string). This is the single source of truth for "what counts as a turn";
// rewind's turn-index targeting must agree with this definition or it
// resolves to the wrong message.
export function isRealUserTurn(m) {
  if (m.type !== 'user') return false;
  const content = m.message && m.message.content;
  return typeof content === 'string' && content.length > 0 && !isSentinel(content);
}

// How many real user turns already exist in a transcript - used to seed
// session.js's turnCounter when resuming, so a live turnIndex (1-based,
// counting only *this process's* pushInput calls) still lands on the right
// message when resolveTurnUuid indexes into the transcript as a whole.
export function countRealUserTurns(messages) {
  return messages.filter(isRealUserTurn).length;
}
