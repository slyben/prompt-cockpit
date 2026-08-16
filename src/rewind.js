// Rewind = forkSession() for the conversation plus rewindFiles() for the
// files (plan MVP2). Both operate on a live session's row from the
// registry; the registry decides what happens to the fork (opens it as a
// new cockpit session) so this module stays a thin, testable wrapper
// around the SDK calls.
import { forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { isRealUserTurn } from './session-history.js';

/**
 * Resolve a client-visible `turnIndex` (1-based - see session.js's
 * `turnCounter`, seeded with `turnIndexOffset` on resume so it stays
 * aligned with this function's indexing into the *whole* persisted
 * transcript, not just this process's turns) to the uuid the CLI actually
 * assigned that user message. Neither the wire message nor its `result`
 * carries a usable uuid (see the comment in session.js's pushInput), so
 * this reads it back from `getSessionMessages` instead - lazily, only when
 * a rewind is actually requested, not spent on every turn.
 *
 * `isRealUserTurn` (session-history.js) is shared with turnCounter's
 * seeding on purpose - two different definitions of "what counts as a
 * turn" is exactly how this drifted off by one before (the priming
 * sentinel persists as a non-empty wrapper string, not truly empty, so a
 * naive length check let it through as turn #1).
 */
export async function resolveTurnUuid(claudeSessionId, cwd, turnIndex) {
  const messages = await getSessionMessages(claudeSessionId, { dir: cwd, limit: 5000 });
  const realUserTurns = messages.filter(isRealUserTurn);
  const target = realUserTurns[turnIndex - 1];
  if (!target) throw new Error(`could not find turn #${turnIndex} in the transcript`);
  return target.uuid;
}

/**
 * Fork the conversation up to (and including) `userMessageId`. Non-
 * destructive: the original session is untouched, this returns a new
 * Claude session id to resume elsewhere.
 */
export async function forkConversation(claudeSessionId, userMessageId) {
  return forkSession(claudeSessionId, { upToMessageId: userMessageId });
}

/**
 * Revert tracked files to their state at `userMessageId`. Requires the
 * session to have been started with `enableFileCheckpointing: true` -
 * callers must check `hasFileCheckpointing` on the row first and skip this
 * rather than let it fail (plan: "disable the file half for sessions
 * without checkpointing rather than letting it fail").
 */
export async function rewindFiles(query, userMessageId, options) {
  return query.rewindFiles(userMessageId, options);
}
