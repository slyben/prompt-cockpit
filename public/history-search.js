// Ctrl+R fuzzy search over prompt-history.js's persisted list - shell
// reverse-search convention. Same dropdown shape as model-picker.js
// (capture-phase keydown, mousedown+preventDefault per row so a click
// doesn't blur first), reusing #commandSuggestions/#modelSuggestions'
// CSS under its own #historySuggestions id.
const MAX_RESULTS = 20;

export function initHistorySearch({ textarea, dropdown, getEntries, fuzzyScore, isPickerOpen }) {
  let open = false;
  let filtered = [];
  let activeIndex = -1;
  // What was actually in the box before Ctrl+R opened this - restored if
  // the search is cancelled (Escape/blur) rather than left showing
  // whatever partial filter text was typed while searching.
  let textBeforeOpen = '';

  textarea.addEventListener('keydown', onKeydown, true);
  textarea.addEventListener('input', () => {
    if (open) filterAndRender();
  });
  textarea.addEventListener('blur', () => setTimeout(() => { if (open) cancel(); }, 150));

  function onKeydown(event) {
    if (event.ctrlKey && event.key.toLowerCase() === 'r' && !open) {
      // file-picker.js/model-picker.js/command-picker.js's own dropdowns
      // don't share a keybinding with this one, but only ever one dropdown
      // should be open at a time - defer to whichever's already up.
      if (isPickerOpen && isPickerOpen()) return;
      event.preventDefault();
      openSearch();
      return;
    }
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation(); // don't also let app.js's Escape-to-stop fire on the same keypress
      cancel();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      render();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation(); // don't let compose.js send the message
      select(activeIndex);
    }
  }

  function openSearch() {
    open = true;
    textBeforeOpen = textarea.value;
    textarea.value = '';
    filterAndRender();
  }

  function filterAndRender() {
    const query = textarea.value.trim();
    const entries = getEntries();
    const scored = [];
    // Newest first - the most recently used prompt is the most likely match
    // for the same query, all else equal.
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const text = entries[i];
      const score = fuzzyScore(text, query);
      if (score !== null) scored.push({ text, score });
    }
    scored.sort((a, b) => a.score - b.score);
    filtered = scored.slice(0, MAX_RESULTS).map((s) => s.text);
    activeIndex = filtered.length ? 0 : -1;
    render();
  }

  function render() {
    dropdown.innerHTML = '';
    if (!filtered.length) {
      const empty = document.createElement('li');
      empty.className = 'cmd-desc';
      empty.textContent = getEntries().length ? 'No matches' : 'No prompt history yet for this folder';
      dropdown.append(empty);
      dropdown.classList.add('show');
      return;
    }
    filtered.forEach((text, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      li.className = i === activeIndex ? 'active' : '';
      const name = document.createElement('span');
      name.className = 'cmd-name';
      name.textContent = text;
      name.title = text;
      li.append(name);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in textarea, don't fire blur before select() runs
        select(i);
      });
      dropdown.append(li);
    });
    dropdown.classList.add('show');
  }

  // Selecting loads the prompt back into the box for review/editing, same
  // as a shell's reverse-search Enter - it does not send it outright, since
  // an old prompt may no longer be exactly right for right now.
  function select(i) {
    const text = filtered[i];
    close();
    if (text === undefined) return;
    textarea.value = text;
    textarea.dispatchEvent(new Event('input')); // compose.js's autosize listens for this
    placeCaretEnd();
  }

  function cancel() {
    close();
    textarea.value = textBeforeOpen;
    textarea.dispatchEvent(new Event('input'));
    placeCaretEnd();
  }

  function placeCaretEnd() {
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }

  function close() {
    open = false;
    dropdown.classList.remove('show');
    dropdown.innerHTML = '';
    filtered = [];
    activeIndex = -1;
  }

  return { isOpen: () => open };
}
