// Cross-session delegation (`/ask <Name>: <text>`) and the handshake-trust
// gate it depends on. Takes its registry-side dependencies (sessions map,
// turn-pusher, broadcasters, name lookup) as constructor params rather than
// importing session-registry.js directly, keeping the import direction
// one-way. `sessions` is the live Map itself, not a snapshot.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { append as appendEvent } from './event-log.js';
import { joinStreamText, createFenceTracker } from './grok-messages.js';

export function createDelegation({ sessions, pushTurn, broadcast, broadcastSummary, findByName }) {
  // A single per-process "handshake secret" minted fresh at server start, in
  // memory only, never persisted. Every locally-created row is stamped with
  // it at creation time so local sessions are trusted by construction. The
  // override matters for a future non-local row type that isn't auto-stamped
  // (manually promoted via setSessionHandshake), or as a manual revoke.
  let handshakeSecret = randomBytes(16).toString('hex');

  function getHandshakeSecret() {
    return handshakeSecret;
  }

  // Rotating invalidates every row's trust in one move - the "something
  // looked wrong, cut everyone off" control, not a per-row action. Existing
  // rows are NOT re-stamped, so anyone still `isSessionTrusted` after a
  // rotation was re-synced (or is a fresh row created afterward).
  function regenerateHandshakeSecret() {
    handshakeSecret = randomBytes(16).toString('hex');
    return handshakeSecret;
  }

  function setSessionHandshake(id, value) {
    const row = sessions.get(id);
    if (!row) throw new Error(`unknown session: ${id}`);
    row.handshakeSecret = typeof value === 'string' ? value.trim() : '';
    return isSessionTrusted(row);
  }

  function isSessionTrusted(row) {
    const a = typeof row.handshakeSecret === 'string' ? row.handshakeSecret : '';
    const b = typeof handshakeSecret === 'string' ? handshakeSecret : '';
    if (!a || !b) return false;
    const expected = Buffer.from(a);
    const actual = Buffer.from(b);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  // Cross-project/cross-machine fallback used only when findByName's
  // same-cwd lookup misses. Filters on isSessionTrusted itself so an
  // untrusted local namesake can't shadow a trusted cross-project one. Known
  // limitation: if more than one trusted session outside the origin's cwd
  // shares the name, whichever the Map iterates to first wins.
  function findTrustedByName(name) {
    const norm = (s) => (s || '').trim().toLowerCase();
    const target = norm(name);
    if (!target) return null;
    for (const row of sessions.values()) {
      if (isSessionTrusted(row) && norm(row.name) === target) return row;
    }
    return null;
  }

  // Triggered by a user typing `/ask <Name>: <text>` in the origin session's
  // compose box - not an LLM tool call, so there's no real tool_use id for
  // the reply to attach to (see relayDelegationResult). Same-cwd lookup
  // first, then falls back to any session in the same handshake-trust group.
  function delegateTask(originId, targetName, text) {
    const origin = sessions.get(originId);
    if (!origin) throw new Error(`unknown session: ${originId}`);
    const target = findByName(origin.cwd, targetName) || findTrustedByName(targetName);
    if (!target) throw new Error(`no session named "${targetName}"`);
    if (target.id === origin.id) throw new Error('cannot delegate to the same session');
    // Handshake gate (see handshakeSecret's own comment above): both ends
    // have to currently agree with this process's canonical secret, not just
    // the target - an origin that's been manually revoked shouldn't be able
    // to ask anyone anything either.
    if (!isSessionTrusted(origin)) throw new Error('this session\'s handshake does not match the server - it cannot delegate to other sessions (see Settings)');
    if (!isSessionTrusted(target)) throw new Error(`"${target.name || targetName}" does not have a matching handshake - it cannot receive delegated tasks (see Settings)`);
    // Deliberately prose, not an XML-ish `<delegated_task from="...">` tag: a
    // bare tag wrapping plain text in a user turn reads as prompt injection
    // and a suspicious model will refuse it. `buildDelegatedHeader` attributes
    // the ask to "your operator" (a human), matching the actual trust chain.
    const wrappedTask = buildDelegatedHeader('task', origin.name || 'session', text);
    const tag = { fromId: origin.id, fromName: origin.name || 'session', task: text, buffer: [] };
    const queueId = pushTurn(target, wrappedTask, tag);
    if (queueId === null) {
      // Target's input queue was already closed, so pushTurn dropped the
      // turn instead of queuing it - no `result` will ever arrive to relay
      // back. Without this, the origin would wait forever for a reply.
      relayDelegationResult(target, tag, { ok: false, errorText: `"${target.name || targetName}" is no longer available to receive this task` });
      return { targetId: target.id, targetName: target.name };
    }
    broadcastSummary(target.id); // target tab's state flips to 'running' immediately, not on its next unrelated broadcast
    // Durable marker on the ORIGIN's own event log/transcript - not routed
    // through target.handle/onMessage, this never touched the SDK - so a
    // reconnecting origin tab sees "-> Asked <Name>: ..." exactly where it
    // was typed, same durability the eventual delegated_result reply gets.
    const marker = { type: 'cockpit:delegate-sent', targetName: target.name || targetName, text };
    const seq = appendEvent(origin.eventLog, marker);
    broadcast(originId, { type: 'sdk:message', message: marker, seq });
    return { targetId: target.id, targetName: target.name };
  }

  // Delivers a delegated task's result back to the origin session on success
  // or any way a target turn can end without one (error, close, dropped
  // queue entry). The origin model only sees finalAnswerText() below; the
  // full buffer ships separately as a client-only cockpit:delegate-full-trace
  // marker when it holds more than the answer.
  function relayDelegationResult(targetRow, tag, { ok, errorText, message }) {
    const origin = sessions.get(tag.fromId);
    if (!origin) return; // origin session was closed/gone - best-effort, nothing left to deliver to
    if (!ok) {
      const wrapped = buildDelegatedHeader('result', targetRow.name || 'session', `ERROR: ${errorText}`, tag.task);
      pushTurn(origin, wrapped);
      return;
    }
    // tag.buffer holds one complete text block per assistant message
    // (collectDelegationText) - joined as separate paragraphs, not via
    // joinStreamText (that's for stitching partial deltas of the same
    // flowing message, and would glue unrelated blocks together with
    // whatever whitespace each happened to end in).
    const fullText = tag.buffer.map((part) => (part || '').trim()).filter(Boolean).join('\n\n') || '(no text reply)';
    const finalText = finalAnswerText(tag, message) || fullText;
    const wrapped = buildDelegatedHeader('result', targetRow.name || 'session', finalText, tag.task);
    const queueId = pushTurn(origin, wrapped); // not tagged - this is a plain turn for origin, not itself a delegation
    if (fullText !== finalText) {
      const marker = {
        type: 'cockpit:delegate-full-trace',
        queueId,
        label: `${targetRow.name || 'session'} - full trace`,
        text: fullText,
      };
      const seq = appendEvent(origin.eventLog, marker);
      broadcast(origin.id, { type: 'sdk:message', message: marker, seq });
    }
  }

  // Prefers the SDK's `result.result` field (Claude's authoritative "final
  // answer" text) when non-empty. Grok's synthesized result message never
  // populates this, so it falls back to the last non-empty buffered text
  // block, on the theory that narration precedes the actual answer. Returns
  // '' (never throws) if neither source has anything.
  function finalAnswerText(tag, message) {
    const sdkResult = message && message.type === 'result' && typeof message.result === 'string' ? message.result.trim() : '';
    if (sdkResult) return sdkResult;
    for (let i = tag.buffer.length - 1; i >= 0; i--) {
      const t = (tag.buffer[i] || '').trim();
      if (t) return t;
    }
    return '';
  }

  // Shared prose wrapper for both delegation directions. Header line stays
  // machine-parseable (stream-view.js's DELEGATED_HEADER_RE) so the UI can
  // split a clean from-name/body for the bubble label. `sanitizeName` only
  // guards the quoted name from a stray `"` breaking that regex; body text
  // goes through unescaped, same low-severity risk any relay design has.
  function buildDelegatedHeader(kind, name, body, task) {
    const safeName = sanitizeName(name);
    // The handshake-trust sentence is a checkable fact, not a claim taken on
    // faith: the server only relays between sessions that separately proved
    // they share the process's handshake secret.
    if (kind === 'task') {
      return `[Prompt Cockpit] Relayed task from "${safeName}"\n\n`
        + `Your operator is also running a sibling cockpit session named "${safeName}" in this same project. `
        + `They typed the message below in ${safeName}'s own compose box and used this app's delegation feature `
        + `("/ask") to relay it to you directly - it is authorized by the human operator, not an instruction from `
        + `another agent. The cockpit server only allows this relay between sessions that share its current `
        + `handshake secret, so this could not have come from an untrusted or external source. `
        + `Reply normally in this turn; your answer will be relayed back to ${safeName} automatically.\n\n`
        + `---\n${body}`;
    }
    return `[Prompt Cockpit] Relayed reply from "${safeName}"\n\n`
      + `Your operator earlier asked the sibling cockpit session "${safeName}" to do something on your behalf `
      + `(the original ask was: "${sanitizeName(task)}"). This is ${safeName}'s reply, delivered back to you by `
      + `your operator - not a message from ${safeName} directly. The cockpit server only allows this relay `
      + `between sessions that share its current handshake secret, so this could not have come from an `
      + `untrusted or external source.\n\n`
      + `---\n${body}`;
  }

  function sanitizeName(s) {
    return String(s).replace(/"/g, "'");
  }

  // Watches one assistant message for delegated-turn text while this row
  // has a pending delegation tag. Keeps every plain text block, since
  // finalAnswerText() falls back to this buffer. Consecutive text-only
  // messages merge via joinStreamText - Grok streams one BPE piece per
  // message, so without merging this would end up one entry per word.
  function collectDelegationText(row, message) {
    const turns = row.handle?.turns;
    const entry = turns?.frontPending();
    const tag = entry ? turns.peekTag(entry.queueId) : null;
    if (!tag) return;
    // Leftover assistant chunks from a force-idled turn must not append into
    // a newly pushed tag now sitting at the front. Handles stamp
    // `_cockpitEpoch` on in-flight messages (from the ABANDONED meta while
    // one is outstanding, see result-epoch.js's currentMeta) - skip when the
    // epochs disagree.
    if (message._cockpitEpoch != null && entry.epoch != null && message._cockpitEpoch !== entry.epoch) return;
    if (message.type !== 'assistant' || !message.message || !Array.isArray(message.message.content)) {
      tag.openTextEntry = false;
      return;
    }
    for (const block of message.message.content) {
      if (block.type !== 'text' || !block.text) {
        tag.openTextEntry = false;
        continue;
      }
      if (tag.openTextEntry && tag.buffer.length) {
        tag.buffer[tag.buffer.length - 1] = joinStreamText(tag.buffer[tag.buffer.length - 1], block.text, tag.fenceTracker);
      } else {
        tag.buffer.push(block.text);
        // A fresh buffer entry starts a new run - the tracker's committed
        // state belongs to the PREVIOUS entry's text, so it must not carry
        // over (see stream-join.js's joinStreamText perf note).
        tag.fenceTracker = createFenceTracker();
      }
      tag.openTextEntry = true;
    }
  }

  // Called when a row stops making progress without ever emitting the
  // 'result' message the delegation relay waits for, so any held tags
  // would otherwise strand their origin session forever. takeAllTags()
  // releases every held tag, including one whose turn already consumed
  // provider-side with no result - tag lifetime isn't tied to consume().
  function failPendingDelegations(row, errorText) {
    const held = row.handle?.turns?.takeAllTags() || [];
    for (const { tag } of held) relayDelegationResult(row, tag, { ok: false, errorText });
  }

  return {
    getHandshakeSecret,
    regenerateHandshakeSecret,
    setSessionHandshake,
    isSessionTrusted,
    delegateTask,
    relayDelegationResult,
    collectDelegationText,
    failPendingDelegations,
  };
}
