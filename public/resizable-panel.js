// Shared drag-to-resize behavior for a right-docked panel with a
// left-edge handle. Factored out after a second panel grew a near-
// identical copy of the same drag math. Deliberately narrow - only drag
// math + persistence (`panel.style.width`); callers needing more wire
// that themselves around this.
export function initResizablePanel({ panel, handle, minWidthPx, initialWidth, onWidthChange, isNarrowLayout }) {
  if (initialWidth != null && !isNarrowLayout?.()) {
    panel.style.width = `${Math.max(initialWidth, minWidthPx)}px`;
  }
  if (!handle) return;

  let dragStartX = null;
  let dragStartWidth = null;

  handle.addEventListener('mousedown', (event) => {
    if (isNarrowLayout?.()) return; // handle is visually still there but inert in a stacked layout
    event.preventDefault(); // don't let the drag start a text selection
    dragStartX = event.clientX;
    dragStartWidth = panel.getBoundingClientRect().width;
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  });

  function onDragMove(event) {
    const maxPx = window.innerWidth * 0.7; // leaves the main content at least 30% of the viewport
    // Dragging left (clientX decreases) grows the box - the panel is
    // right-docked, so this is inverted vs. a normal left-to-right resize.
    const target = Math.min(Math.max(dragStartWidth + (dragStartX - event.clientX), minWidthPx), maxPx);
    panel.style.width = `${target}px`;
  }

  function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    // Persisted once per drag, not per mousemove - onWidthChange is a
    // patchSettings() call, cheap but no reason to hammer localStorage
    // dozens of times a second while dragging.
    onWidthChange?.(Math.round(panel.getBoundingClientRect().width));
  }
}
