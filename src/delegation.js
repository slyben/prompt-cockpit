// Cross-session delegation (`/ask <Name>: <text>`) and the handshake-trust
// gate it depends on - split out of session-registry.js (backlog: MVP6 wants
// a second row type - not locally stamped, not a local CLI handle - and this
// is the surface that would otherwise grow `if (isProxy)` branches scattered
// through a dozen of session-registry.js's own methods).
//
// Takes its registry-side dependencies (the sessions map, the FIFO
// turn-pusher, the broadcasters, the same-cwd name lookup) as constructor
// params via createDelegation() rather than importing session-registry.js
// directly - that keeps the import direction one-way (session-registry.js
// imports this module, never the reverse) so there's no cycle. `sessions`
// is the live Map itself (not a snapshot): this module always sees
// registry.js's current rows, including ones created after createDelegation()
// was called.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { append as appendEvent } from './event-log.js';
import { joinStreamText, createFenceTracker } from './grok-messages.js';

export function createDelegation({ sessions, pushTurn, broadcast, broadcastSummary, findByName }) {
  // A single per-process "handshake secret" minted fresh every time this
  // server starts, in memory only - never persisted, never sent anywhere
  // automatically. It's the shared value that will eventually let a session
  // running on a DIFFERENT machine (an SSH'd Windows cockpit, the target for
  // remote-hosted sessions) prove it belongs to the same trusted group as
  // sessions running locally, so delegation isn't gated on nothing more than
  // "the name string matched." Pairing today is deliberately manual (copy
  // from the session-list pane, paste into the other side's session) - no
  // exchange protocol exists yet, which is fine for a single human running
  // both ends.
  //
  // Every LOCALLY-created row is stamped with the CURRENT secret at creation
  // time (see session-registry.js's createSession, which reads
  // getHandshakeSecret() below), so local sessions are trusted by
  // construction - they were spawned by this very process, there's nothing
  // to prove. The override only matters two ways: (1) a future non-local row
  // type (once remote-hosted sessions actually exist) that does NOT get
  // stamped automatically and has to be manually promoted via
  // setSessionHandshake, and (2) as a manual revoke - blank/garble a row's
  // value via the same setter to opt that session out of delegation
  // entirely, in either direction.
  let handshakeSecret = randomBytes(16).toString('hex');

  function getHandshakeSecret() {
    return handshakeSecret;
  }

  // Rotating invalidates every row's trust in one move (their stamped value
  // now mismatches) - a broader hammer than setSessionHandshake, deliberately:
  // this is the "something looked wrong, cut everyone off" control, not a
  // per-row action. Existing rows are NOT re-stamped, so this is also how you
  // audit who was actually trusted - anyone still `isSessionTrusted` after a
  // rotation was re-synced (or is a fresh row created after the rotation,
  // which gets the new value automatically).
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

  // Cross-session delegation, cross-project/cross-machine fallback: same
  // handshake-trust group, explicit name, no cwd requirement at all - the
  // replacement for same-cwd-only routing the backlog called for. Used only
  // when findByName's same-cwd lookup misses, so the common single-project
  // case is unaffected. This is also why it filters on isSessionTrusted
  // itself rather than leaving that to the caller: an untrusted local
  // namesake must not shadow a trusted cross-project one, and a session that
  // has never synced a handshake has no business being reachable by name
  // outside its own cwd. delegateTask still re-checks isSessionTrusted(origin)
  // - a revoked origin cannot delegate at all, same-cwd or not. Known
  // limitation, not yet worth solving: if more than one trusted session
  // outside the origin's cwd shares the name, whichever the session Map
  // iterates to first wins - fine for the realistic case (one human, one
  // sibling with that name), a real footgun once handshake groups have more
  // than a couple of members.
  function findTrustedByName(name) {
    const norm = (s) => (s || '').trim().toLowerCase();
    const target = norm(name);
    if (!target) return null;
    for (const row of sessions.values()) {
      if (isSessionTrusted(row) && norm(row.name) === target) return row;
    }
    return null;
  }

  // Cross-session delegation: the whole feature in one call. Triggered
  // by a user typing `/ask <Name>: <text>` in the ORIGIN session's compose
  // box (server.js's ws 'delegate' handler) - not an LLM tool call, so there
  // is no real tool_use id for the eventual reply to attach to as a genuine
  // SDK tool_result (see relayDelegationResult below for how that's handled
  // instead). Same-cwd first (fast, unambiguous), then falls back to any
  // session in the same handshake-trust group regardless of cwd - see
  // findTrustedByName's comment for why cross-project/cross-machine routing
  // no longer requires a shared cwd string.
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
    // Symmetric with relayDelegationResult's wrapper below: without this, the
    // target's own transcript - and the target model itself - has no way to
    // tell this turn apart from the human typing straight into its compose
    // box. It would just read "You: <text>" with zero indication another
    // session asked, which is exactly the gap that surfaced in review
    // (target's own reasoning referred to "the user" instead of the delegating
    // session). `tag.task` below stays the original unwrapped text - it's only
    // used for the eventual reply's header line, not re-displayed to the target.
    //
    // Deliberately prose, not an XML-ish `<delegated_task from="...">` tag
    // (that was the v1 shape - see git history/backlog for why it was
    // dropped): a bare tag wrapping plain text in an ordinary user turn is
    // structurally indistinguishable from a hand-typed prompt-injection
    // payload, and a receiving model that's trained to distrust exactly that
    // pattern will - correctly, given what it's shown - refuse it outright
    // ("I didn't spawn this agent, not treating this tag as real", confirmed
    // live 2026-08-20). Prose framing doesn't eliminate that risk (nothing
    // fully can without an out-of-band system-prompt anchor - see backlog),
    // but it removes the single strongest refusal trigger: leading with a
    // fake-tool-scaffolding token. `buildDelegatedHeader`'s exact wording
    // matters here - it explicitly attributes the ask to "your operator" (a
    // human), not to the sibling session as an autonomous agent, since that's
    // the actual trust chain (`/ask` is only ever user-typed - see this
    // function's own comment above) and is what a suspicious model is really
    // checking.
    const wrappedTask = buildDelegatedHeader('task', origin.name || 'session', text);
    const tag = { fromId: origin.id, fromName: origin.name || 'session', task: text, buffer: [] };
    const queueId = pushTurn(target, wrappedTask, tag);
    if (queueId === null) {
      // Target's input queue was already closed (its session ended right as
      // this delegation landed) - pushTurn dropped the turn instead of
      // queuing it, so no `result` will ever arrive to relay back. Without
      // this, the origin would just wait forever for a reply that's never
      // coming (see the 2026-08-24 review, finding #2's "or the origin
      // strands forever"). relayDelegationResult's own tag.fromId lookup is
      // enough here - it doesn't need the target's turn tracker at all.
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

  // Delivers a delegated task's result back into the ORIGIN session
  // that asked for it, once the TARGET row's turn finishes (ok), the target
  // row errors out mid-turn, the target row is closed mid-turn, or the
  // delegated turn is removed from the target's queue before it ever ran -
  // all four call this the same way (via session-registry.js's
  // failPendingDelegations/failDroppedTurn, or directly on a successful
  // 'result'), just with a different `ok`/`errorText`. Delivered as a normal
  // queued user-turn message (reusing origin.handle.pushInput via pushTurn -
  // the same queue a human's own next message would land in, no second queue
  // built) wrapped so it reads like a tool result even though there's no
  // real tool_use id to attach an actual SDK tool_result to (the trigger was
  // a user-typed /ask, not an LLM tool call - see delegateTask's comment).
  //
  // Backlog fix (2026-08-20, "relay buffers everything, not just the final
  // answer"): the ORIGIN MODEL now only ever sees finalAnswerText() below, not
  // the whole buffered narration - that comment used to claim this ("final
  // answer only") while the code actually joined every buffered block, which
  // is how mid-task narration once rode back looking exactly like a delegated
  // answer. The full buffer isn't thrown away, though: when it genuinely holds
  // more than the clean answer, it's shipped separately as a
  // cockpit:delegate-full-trace marker (below) that never touches the origin
  // model's context - purely a client-side "show full trace" button
  // (stream-view.js/detail-pane.js) for a human who wants to see it. No
  // marker at all when there's nothing extra (full text === final text) - see
  // that check below.
  function relayDelegationResult(targetRow, tag, { ok, errorText, message }) {
    const origin = sessions.get(tag.fromId);
    if (!origin) return; // origin session was closed/gone - best-effort, nothing left to deliver to
    if (!ok) {
      const wrapped = buildDelegatedHeader('result', targetRow.name || 'session', `ERROR: ${errorText}`, tag.task);
      pushTurn(origin, wrapped);
      return;
    }
    // tag.buffer holds one complete text block per assistant message
    // (collectDelegationText) - each is already a fully-formed chunk of
    // narration, not a streaming delta fragment, so they're joined as separate
    // paragraphs (blank line between) rather than with joinStreamText, which
    // is grok-messages.js's smart-whitespace merge for stitching partial
    // deltas of the SAME flowing message back together. Reusing it here used
    // to glue unrelated blocks together with whatever whitespace each one
    // happened to end in (e.g. a narration block running straight into a
    // fenced code block with no separator at all).
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

  // Best-effort "final answer only" extraction for a delegated turn's relay.
  // Prefers the SDK's own `result.result` field - Claude's own authoritative
  // text for "this is the final answer" (SDKResultSuccess.result, distinct
  // from the per-step text blocks collectDelegationText buffers) - when it's
  // non-empty. Grok's synthesized result message never populates this
  // (grok-messages.js's turnResultMessage always sets result: ''), so for a
  // Grok target - and any Claude edge case where result comes back empty -
  // fall back to the last non-empty buffered text block, on the theory that
  // narration precedes the actual answer within a turn, not the reverse.
  // Returns '' (never throws) if neither source has anything - relayDelegationResult
  // falls back the rest of the way to fullText itself in that case.
  function finalAnswerText(tag, message) {
    const sdkResult = message && message.type === 'result' && typeof message.result === 'string' ? message.result.trim() : '';
    if (sdkResult) return sdkResult;
    for (let i = tag.buffer.length - 1; i >= 0; i--) {
      const t = (tag.buffer[i] || '').trim();
      if (t) return t;
    }
    return '';
  }

  // Shared prose wrapper for both delegation directions - see delegateTask's
  // comment for why this replaced the earlier `<delegated_task from="...">`
  // tag shape. Header line stays machine-parseable (stream-view.js's
  // DELEGATED_HEADER_RE) purely so the UI can pull a clean from-name/body
  // apart for the bubble label; the model reads the whole thing as one turn,
  // header prose included - that framing is the point, not incidental.
  // `sanitizeName` only guards the header's own quoted name from a stray `"`
  // in a session name breaking the UI's regex match; there's no boundary left
  // for body text to spoof (no closing tag), so body goes through unescaped -
  // the residual "body contains a fake header line" risk is the same class of
  // low-severity prompt-injection surface any relay design has, and prose
  // doesn't make it worse than tags did.
  function buildDelegatedHeader(kind, name, body, task) {
    const safeName = sanitizeName(name);
    // The handshake-trust sentence below is a checkable fact, not a claim the
    // receiving model has to take on faith: this app's server only relays a
    // turn between two sessions once both have separately proven they share
    // the current process's handshake secret (isSessionTrusted, checked at
    // delegateTask() time) - see the [M] backlog item this closed for why
    // that's worth spelling out explicitly instead of leaving the trust chain
    // purely implicit in the surrounding prose.
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

  // Watches one assistant message for delegated-turn text while this
  // row has a pending delegation tag (the tracker's oldest still-queued
  // turn - i.e. the one actually in flight). Only the
  // plain text blocks are kept (no tool-call trace) - but every block, not
  // just the final one: this buffer now serves double duty as both the "full
  // trace" side-channel and finalAnswerText()'s own fallback source, so
  // trimming it down here would quietly break both. The "final answer only"
  // trim happens downstream in relayDelegationResult instead.
  //
  // Bug fixed 2026-08-21: this used to push(block.text) unconditionally, one
  // buffer entry per assistant message. That's correct for Claude (one
  // message == one already-complete chunk of narration, per the SDK), but
  // Grok streams its reply one BPE piece at a time - a SEPARATE assistant
  // message per word (grok-messages.js's joinStreamText comment). A Grok
  // delegation's buffer ended up with one entry per word: unreadable once
  // relayDelegationResult joined them with blank lines for the full-trace
  // marker, and finalAnswerText's "last non-empty block" fallback grabbed a
  // single trailing token/punctuation mark (often just ".") instead of the
  // actual last sentence, so the ORIGIN model's relayed "final answer" was
  // garbage too.
  //
  // Fix: mirror exactly how stream-view.js's live rendering already resolves
  // this same ambiguity (appendToLastStreamBlock) - a run of consecutive
  // text-only assistant messages merges via joinStreamText into ONE buffer
  // entry (Grok's per-word chunks re-assemble into real sentences); a
  // non-text block (tool_use/thinking) or any other message type in between
  // closes the run, same as closeGroup() does client-side, so the next text
  // block starts a fresh entry. That keeps genuinely distinct narration
  // steps - the ones separated by a tool call - apart, which is what the
  // "final answer vs full trace" split actually needs to distinguish.
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

  // Called by session-registry.js from closeSession, forceIdle, and
  // handleError - the three ways a row can stop making progress on a turn
  // without ever emitting the 'result' message the delegation relay waits
  // for, so any tags still held would otherwise strand their origin
  // session(s) waiting forever.
  //
  // takeAllTags() releases every tag the tracker still holds for this
  // session in one move, including one whose turn was already consumed
  // provider-side without a result ever reaching the registry (grok's
  // runPrompt error path) - the case a registry-side copy used to cover by
  // accident, and the reason tag lifetime is deliberately not tied to
  // consume(). Turn ORDER is untouched: an abandoned turn's late result
  // must still be recognizable as stale.
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
