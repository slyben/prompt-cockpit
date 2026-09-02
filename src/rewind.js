// Rewind = forkSession() for the conversation plus rewindFiles() for the
// files. Both operate on a live session's row from the
// registry; the registry decides what happens to the fork (opens it as a
// new cockpit session) so this module stays a thin, testable wrapper
// around the SDK calls.
import { forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { isRealUserTurn } from './session-history.js';

/**
 * Resolve a client-visible 1-based `turnIndex` to the uuid the CLI
 * assigned (lazy `getSessionMessages` read, only when rewind is
 * requested). Must match session.js's turnCounter seeding, or the
 * count drifts off by one. */
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
 * Revert tracked files to their state at `userMessageId`. Requires
 * `enableFileCheckpointing: true` at session start - callers must
 * check `hasFileCheckpointing` first and skip this rather than fail. */
export async function rewindFiles(query, userMessageId, options) {
  return query.rewindFiles(userMessageId, options);
}
