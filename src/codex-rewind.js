import { codexThreadToMessages } from './codex-messages.js';
import { countRealUserTurns } from './session-history.js';

// Match the transcript's visible user-message numbering, not the raw number
// of Codex turns (which can include turns without a visible user message).
export function resolveCodexRewindTurn(thread, turnIndex) {
  if (!Number.isInteger(turnIndex) || turnIndex < 1) {
    throw new Error('turnIndex (1-based integer) required');
  }
  let count = 0;
  for (const [index, turn] of (thread?.turns || []).entries()) {
    const users = countRealUserTurns(codexThreadToMessages({ id: thread.id, turns: [turn] }));
    count += users;
    if (users && count >= turnIndex) {
      if (count !== turnIndex) throw new Error('Codex can only fork at the end of a turn containing multiple user messages');
      if (!turn.id) throw new Error('Codex rewind target has no turn id');
      if (!['completed', 'interrupted', 'failed'].includes(turn.status)) {
        throw new Error('Wait for the selected Codex turn to finish, or stop it before rewinding');
      }
      return { turnId: turn.id, index };
    }
  }
  throw new Error(`could not find turn #${turnIndex} in the Codex transcript`);
}

export async function rewindCodexConversation(manager, threadId, cwd, turnIndex, { dryRun = false } = {}) {
  const source = await manager.request('thread/read', { threadId, includeTurns: true });
  const target = resolveCodexRewindTurn(source?.thread, turnIndex);
  const filesResult = { conversationOnly: true, turnId: target.turnId };
  if (dryRun) return { filesResult, forkedSessionId: null };

  // lastTurnId is inclusive. Never roll back the source or touch workspace files.
  // The fork inherits its cwd from the source thread; cwd is kept in this
  // function's signature for the provider-handle contract, but is not a
  // thread/fork parameter in the app-server protocol.
  const result = await manager.request('thread/fork', { threadId, lastTurnId: target.turnId });
  const fork = result?.thread;
  if (!fork?.id || fork.id === threadId) throw new Error('Codex did not return a new forked thread');
  try {
    // thread/fork returns a thread summary, not the copied turns. Read the
    // child explicitly before opening it so an older server that ignores
    // lastTurnId cannot silently produce a full-history fork.
    const forkedHistory = await manager.request('thread/read', { threadId: fork.id, includeTurns: true });
    const forkedTurns = forkedHistory?.thread?.turns;
    const expected = source.thread.turns.slice(0, target.index + 1);
    if (!Array.isArray(forkedTurns) || forkedTurns.length !== expected.length
      || forkedTurns.some((turn, index) => turn.id !== expected[index].id)) {
      throw new Error('Codex did not honor the rewind boundary; update the Codex CLI and try again');
    }
    return { filesResult, forkedSessionId: fork.id };
  } finally {
    // Fork loads the child on this connection. The route will resume it into
    // its own session handle; release this temporary subscription first.
    await manager.request('thread/unsubscribe', { threadId: fork.id }).catch(() => {});
  }
}
