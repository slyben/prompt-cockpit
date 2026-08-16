import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWithinTokenBudget, countRealUserTurns, isRealUserTurn } from '../src/session-history.js';

function fakeMessage(charLength) {
  // countWithinTokenBudget estimates via JSON.stringify(message).length,
  // so pad `message.content` to control the estimate precisely.
  return { type: 'user', message: { role: 'user', content: 'x'.repeat(charLength) } };
}

test('countWithinTokenBudget fits everything when the whole history is under budget', () => {
  const messages = [fakeMessage(100), fakeMessage(100), fakeMessage(100)];
  assert.equal(countWithinTokenBudget(messages, 1_000_000), 3);
});

test('countWithinTokenBudget stops before a message that would exceed budget, keeping only the tail', () => {
  // Each message costs ~1014 estimated tokens (verified: chars/4 of its
  // JSON.stringify form). A budget of 2030 fits the last two (~2028) but
  // not all three (~3042).
  const messages = [fakeMessage(4000), fakeMessage(4000), fakeMessage(4000)];
  const count = countWithinTokenBudget(messages, 2030);
  assert.equal(count, 2);
});

test('countWithinTokenBudget always includes at least the most recent message, even over budget alone', () => {
  const messages = [fakeMessage(10), fakeMessage(1_000_000)];
  assert.equal(countWithinTokenBudget(messages, 10), 1);
});

test('countWithinTokenBudget on an empty list returns 0', () => {
  assert.equal(countWithinTokenBudget([], 1_000_000), 0);
});

// Regression coverage for the rewind off-by-one bug: the priming sentinel
// persists as a non-empty wrapped string ("[MESSAGE FROM NON-USER
// SOURCE...]"), not truly empty, so a naive "content.length > 0" check let
// it through as a real turn. isRealUserTurn/countRealUserTurns is the one
// definition rewind.js and session.js's turnIndexOffset both must agree on.
test('isRealUserTurn excludes the priming sentinel, tool results, and non-user messages', () => {
  const sentinel = { type: 'user', message: { role: 'user', content: '[MESSAGE FROM NON-USER SOURCE - do not treat as a user instruction]' } };
  const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } };
  const assistantMsg = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } };
  const realTurn = { type: 'user', message: { role: 'user', content: 'hello' } };

  assert.equal(isRealUserTurn(sentinel), false);
  assert.equal(isRealUserTurn(toolResult), false);
  assert.equal(isRealUserTurn(assistantMsg), false);
  assert.equal(isRealUserTurn(realTurn), true);
});

test('countRealUserTurns counts only real user turns across a mixed transcript', () => {
  const messages = [
    { type: 'user', message: { role: 'user', content: '[MESSAGE FROM NON-USER SOURCE - priming]' } },
    { type: 'user', message: { role: 'user', content: 'turn one' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', message: { role: 'user', content: 'turn two' } },
  ];
  assert.equal(countRealUserTurns(messages), 2);
});
