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
const MIN_HEIGHT_PX = 60;

export function initCompose({ textarea, sendButton, onSend, resizeHandle, streamEl, isScrolledToBottom, isPickerOpen }) {
  // The box auto-grows with typed content (autosize below) and is also
  // manually draggable via resizeHandle - `manualHeight` is the floor
  // autosize won't shrink below once the user has dragged it, so typing
  // afterward doesn't silently undo their resize.
  let manualHeight = null;

  // Up/Down history recall (shell/REPL convention) - in-memory only, reset
  // on page reload. `historyIndex === -1` means "not currently browsing";
  // `draftText` is whatever was in the box when Up was first pressed, so
  // Down all the way back restores it instead of leaving the box empty.
  const history = [];
  let historyIndex = -1;
  let draftText = '';

  function send() {
    const text = textarea.value;
    if (text.trim().length === 0) return;
    onSend(text);
    if (history[history.length - 1] !== text) history.push(text); // skip immediate repeats
    historyIndex = -1;
    draftText = '';
    textarea.value = '';
    manualHeight = null; // a sent message starts the next one fresh, same as content-driven autosize already resetting to min
    autosize();
  }

  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (event.shiftKey) return; // newline, let it through
      event.preventDefault();
      send();
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
    const target = Math.min(Math.max(contentPx, MIN_HEIGHT_PX, manualHeight || 0), maxPx);
    textarea.style.height = `${target}px`;
  }

  return {
    setEnabled(enabled) {
      textarea.disabled = !enabled;
      sendButton.disabled = !enabled;
    },
  };
}
