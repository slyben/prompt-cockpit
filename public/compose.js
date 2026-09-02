// The compose box is the primary input surface. Enter sends; Shift+Enter
// inserts a newline, matching the CLI rather than the usual web-chat
// inversion. Ctrl+Enter was dropped: a textarea has no native newline
// behavior for it, so it only suppressed send without adding one. The
// visible Send button keeps this keyboard-optional for future use.

// Matches index.html's CSS min-height (60px) - duplicated here rather than
// read from computed style, since the two only need to agree, not derive
// from each other. This is just the absolute floor: autosize() below also
// floors against composeSendGroup's real rendered height (usually taller,
// the modeBtn+sendBtn stack) so the two stay top-aligned.
const MIN_HEIGHT_PX = 60;

export function initCompose({ textarea, sendButton, onSend, resizeHandle, streamEl, isScrolledToBottom, isPickerOpen, promptHistory, sendGroupEl }) {
  // The box auto-grows with typed content (autosize below) and is also
  // manually draggable via resizeHandle - `manualHeight` is the floor
  // autosize won't shrink below once the user has dragged it, so typing
  // afterward doesn't silently undo their resize.
  let manualHeight = null;

  // Prompt-suggestion ghost text: app.js computes a suggested next message
  // once a turn ends idle, handed to setSuggestion() below. Shown via the
  // textarea's `placeholder` attribute (not an overlay) - browsers already
  // dim placeholders and show them only while empty, for free. Tab accepts
  // it into the box; Enter on an empty box with a suggestion sends it too.
  let defaultPlaceholder = textarea.placeholder;
  let currentSuggestion = null;

  function setDefaultPlaceholder(text) {
    defaultPlaceholder = text || defaultPlaceholder;
    if (!currentSuggestion) textarea.placeholder = defaultPlaceholder;
  }

  function setSuggestion(text) {
    currentSuggestion = text || null;
    textarea.placeholder = currentSuggestion || defaultPlaceholder;
  }

  function clearSuggestion() {
    setSuggestion(null);
  }

  // Up/Down history recall (shell/REPL convention). The persisted list lives
  // in prompt-history.js; this module only owns the browsing cursor into it.
  // `historyIndex === -1` means "not browsing"; `draftText` holds whatever
  // was in the box when Up was first pressed, so Down past the newest entry
  // restores it. `promptHistory` is optional - Up/Down just no-ops without it.
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
  // capturing keydown listener here and preventDefault arrow keys without
  // stopPropagation - without this check, navigating their dropdown would
  // also silently swap in a history entry underneath it. isPickerOpen is
  // optional; when absent, history recall just always considers itself clear.
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
  const form = sendButton.closest('form');
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      send();
    });
  } else {
    sendButton.addEventListener('click', send);
  }

  // Not the native `resize` handle: that one lives at an element's own
  // bottom-right corner, and this box is pinned to the viewport bottom -
  // there's no room below it to drag into (see index.html's comment).
  // Dragging this handle (above the textarea) up/down grows/shrinks it
  // from the top instead, which is the direction that actually has room.
  if (resizeHandle) {
    let dragStartY = null;
    let dragStartHeight = null;
    // Captured once at drag start, not re-checked per move: a reader at the
    // bottom when they grabbed the handle almost certainly wants to stay
    // pinned as the pane shrinks (same as a new message re-pinning it in
    // stream-view.js). Re-testing mid-drag would drop the pin the instant the
    // shrink itself scrolls them off "at bottom".
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
    // Read fresh each call rather than cached once - composeSendGroup's real
    // height changes with it (modeBtn hidden until a session connects,
    // different OS <select> rendering, page zoom), so this must track the
    // actual current value, not a guessed constant, or CSS's stretch-driven
    // alignment at rest would get undone the moment the user types.
    const sendGroupPx = sendGroupEl ? sendGroupEl.getBoundingClientRect().height : 0;
    const target = Math.min(Math.max(contentPx, MIN_HEIGHT_PX, sendGroupPx, manualHeight || 0), maxPx);
    textarea.style.height = `${target}px`;
  }

  return {
    setEnabled(enabled) {
      textarea.disabled = !enabled;
      sendButton.disabled = !enabled;
    },
    setDefaultPlaceholder,
    setSuggestion,
    clearSuggestion,
  };
}
