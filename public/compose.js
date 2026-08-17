// The compose box is the primary input surface (no pty, nothing else to
// type into). Enter sends; Shift+Enter inserts a newline - matches the CLI
// rather than the usual web-chat inversion. (Ctrl+Enter was dropped: a
// textarea doesn't insert a newline for it by default, so it was only ever
// suppressing send with no newline landing - a documented gap that turned
// out to be a bug, not a feature.) Visible Send button is keyboard-optional
// (sets up MVP7 phone approvals).

// Matches index.html's CSS (min-height: 60px, ~2 lines at 14px/1.4 +
// padding) - kept as one number here rather than read back from computed
// style, since the two only ever need to agree, not derive from each other.
// This is the absolute floor only - autosize() below also floors against
// composeSendGroup's actual rendered height, which is usually taller (the
// modeBtn+sendBtn stack), so the two stay top-aligned (index.html's
// `#compose { align-items: stretch }`) even once typing starts driving an
// explicit inline height.
const MIN_HEIGHT_PX = 60;

export function initCompose({ textarea, sendButton, onSend, resizeHandle, streamEl, isScrolledToBottom, isPickerOpen, promptHistory, sendGroupEl }) {
  // The box auto-grows with typed content (autosize below) and is also
  // manually draggable via resizeHandle - `manualHeight` is the floor
  // autosize won't shrink below once the user has dragged it, so typing
  // afterward doesn't silently undo their resize.
  let manualHeight = null;

  // Prompt-suggestion ghost text (see backlog.md/2026-08-18 - Claude Code's
  // own "prompt suggestions" feature, mirrored here): app.js computes a
  // suggested next message from the last assistant reply once a turn ends
  // idle and hands it to setSuggestion() below. Shown via the textarea's own
  // `placeholder` attribute rather than an overlay element - the browser
  // already renders placeholders dim and only while the box is genuinely
  // empty, which is exactly the behavior wanted here, for free. Tab accepts
  // it into the box (still editable, not sent); Enter on an empty box with a
  // live suggestion accepts *and* sends in one step, matching Claude Code's
  // "tab still accepts for editing" / "Enter accepts and submits" split.
  const defaultPlaceholder = textarea.placeholder;
  let currentSuggestion = null;

  function setSuggestion(text) {
    currentSuggestion = text || null;
    textarea.placeholder = currentSuggestion || defaultPlaceholder;
  }

  function clearSuggestion() {
    setSuggestion(null);
  }

  // Up/Down history recall (shell/REPL convention). The persisted list
  // itself lives in prompt-history.js (backlog.md - survives reload, keyed
  // per cwd, shared with history-search.js's Ctrl+R fuzzy search); this
  // module only owns the browsing cursor into it. `historyIndex === -1`
  // means "not currently browsing"; `draftText` is whatever was in the box
  // when Up was first pressed, so Down all the way back restores it instead
  // of leaving the box empty. `promptHistory` is optional (tests/other
  // embedders may not wire it up) - Up/Down recall just no-ops without it.
  let historyIndex = -1;
  let draftText = '';

  function historyList() {
    return promptHistory ? promptHistory.list() : [];
  }

  function send() {
    const text = textarea.value;
    if (text.trim().length === 0) return;
    onSend(text);
    promptHistory?.record(text);
    historyIndex = -1;
    draftText = '';
    textarea.value = '';
    manualHeight = null; // a sent message starts the next one fresh, same as content-driven autosize already resetting to min
    clearSuggestion(); // whatever was suggested is about to be answered by a new turn - stale the instant this fires
    autosize();
  }

  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (event.shiftKey) return; // newline, let it through
      event.preventDefault();
      // Empty box + a live suggestion: Enter accepts and sends in one step
      // (Claude Code's "Enter accepts and submits prompt suggestions
      // immediately" - Tab below is the "still accepts for editing" path).
      if (textarea.value.length === 0 && currentSuggestion) textarea.value = currentSuggestion;
      send();
      return;
    }
    // Same isPickerOpen guard as onHistoryKey below - file/model/command
    // pickers install their own capturing Tab listener on this textarea and
    // preventDefault without stopPropagation, so without this check their
    // Tab-to-accept would also silently fill in the prompt suggestion
    // underneath it.
    if (event.key === 'Tab' && textarea.value.length === 0 && currentSuggestion && !(isPickerOpen && isPickerOpen())) {
      event.preventDefault();
      textarea.value = currentSuggestion;
      placeCaretEnd();
      autosize();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') onHistoryKey(event);
  });

  // file-picker.js/model-picker.js/command-picker.js each install their own
  // capturing keydown listener on this same textarea and preventDefault
  // arrow keys while their dropdown is open, but don't stopPropagation - so
  // without this check, pressing Up to navigate a suggestion list would
  // also silently swap in a history entry underneath it. isPickerOpen is
  // optional (tests/other embedders may not wire it up) - when absent,
  // history recall just always considers itself clear to act.
  function onHistoryKey(event) {
    if (isPickerOpen && isPickerOpen()) return;
    const history = historyList();
    if (history.length === 0) return;
    const atStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0;
    if (event.key === 'ArrowUp') {
      if (historyIndex === -1) {
        if (!atStart) return; // mid-text cursor move, not history recall
        draftText = textarea.value;
        historyIndex = history.length - 1;
      } else if (historyIndex > 0) {
        historyIndex -= 1;
      } else {
        return; // already showing the oldest entry
      }
      event.preventDefault();
      textarea.value = history[historyIndex];
      placeCaretEnd();
      autosize();
    } else if (event.key === 'ArrowDown') {
      if (historyIndex === -1) return; // not browsing, let the cursor move normally
      event.preventDefault();
      if (historyIndex < history.length - 1) {
        historyIndex += 1;
        textarea.value = history[historyIndex];
      } else {
        historyIndex = -1;
        textarea.value = draftText;
      }
      placeCaretEnd();
      autosize();
    }
  }

  function placeCaretEnd() {
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }

  textarea.addEventListener('input', () => {
    historyIndex = -1; // actual typing (not an arrow-key-driven value swap, which never fires 'input') detaches from history browsing
    autosize();
  });
  sendButton.addEventListener('click', send);

  // Not the native `resize` handle: that one lives at an element's own
  // bottom-right corner, and this box is pinned to the viewport bottom -
  // there's no room below it to drag into (see index.html's comment).
  // Dragging this handle (above the textarea) up/down grows/shrinks it
  // from the top instead, which is the direction that actually has room.
  if (resizeHandle) {
    let dragStartY = null;
    let dragStartHeight = null;
    // Captured once at drag start, not re-checked per move: a reader who
    // was at the bottom when they grabbed the handle almost certainly wants
    // to stay pinned to the tail of the conversation as the pane shrinks,
    // same as a new message re-pins it (stream-view.js) - re-testing mid
    // drag would just drop the pin the instant the shrink itself scrolls
    // them off "at bottom".
    let pinToBottom = false;

    resizeHandle.addEventListener('mousedown', (event) => {
      event.preventDefault(); // don't let the drag start a text selection
      dragStartY = event.clientY;
      dragStartHeight = textarea.getBoundingClientRect().height;
      pinToBottom = streamEl && isScrolledToBottom ? isScrolledToBottom(streamEl) : false;
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
    });

    function onDragMove(event) {
      const maxPx = window.innerHeight * 0.5;
      // Dragging up (clientY decreases) grows the box - the delta is
      // inverted relative to a normal bottom-right resize handle.
      const target = Math.min(Math.max(dragStartHeight + (dragStartY - event.clientY), MIN_HEIGHT_PX), maxPx);
      manualHeight = target;
      textarea.style.height = `${target}px`;
      // The textarea growing/shrinking flexes #stream's height (index.html)
      // but browsers never adjust scrollTop on their own when a scroll
      // container's clientHeight changes - without this, growing the box
      // leaves the reader looking at whatever used to be at the bottom,
      // which is now above the fold instead of at it.
      if (pinToBottom && streamEl) streamEl.scrollTop = streamEl.scrollHeight;
    }

    function onDragEnd() {
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragEnd);
    }
  }

  function autosize() {
    const maxPx = window.innerHeight * 0.5; // mirrors index.html's `max-height: 50vh`
    textarea.style.height = 'auto'; // collapse first so scrollHeight reflects content, not the previous height
    const contentPx = textarea.scrollHeight;
    // Read fresh each call rather than cached once - composeSendGroup's
    // real height changes with it (modeBtn hidden until a session connects,
    // different heights per browser/OS <select> rendering, page zoom) and
    // this has to track whatever it actually is right now, not a guessed
    // constant, or CSS's stretch-driven alignment at rest would just get
    // undone the moment the user types their first character.
    const sendGroupPx = sendGroupEl ? sendGroupEl.getBoundingClientRect().height : 0;
    const target = Math.min(Math.max(contentPx, MIN_HEIGHT_PX, sendGroupPx, manualHeight || 0), maxPx);
    textarea.style.height = `${target}px`;
  }

  return {
    setEnabled(enabled) {
      textarea.disabled = !enabled;
      sendButton.disabled = !enabled;
    },
    setSuggestion,
    clearSuggestion,
  };
}
