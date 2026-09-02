// `/` slash-command autocomplete in the compose box, backed by the SDK's
// supportedCommands(). Commands resolve before the model turn - the
// cockpit just sends plain text. Filters a client-cached list (app.js
// fetches once on connect, refreshes on commands_changed) rather than
// hitting the server per keystroke, since the list is small and static.

// Pure filter+sort, split out so it's unit-testable without a DOM (see
// tests/command-picker.test.mjs) - matches anywhere in the name/alias, not
// just the start (so `/bullet` finds `candidate_bullets`), then sorts
// alphabetically by name.
export function filterCommands(commands, needle) {
  const n = (needle || '').toLowerCase();
  return commands.filter((c) => matches(c, n)).sort((a, b) => a.name.localeCompare(b.name));
}

function matches(command, needle) {
  if (!needle) return true;
  if (command.name.toLowerCase().includes(needle)) return true;
  return (command.aliases || []).some((a) => a.toLowerCase().includes(needle));
}

export function initCommandPicker({ textarea, dropdown, getCommands }) {
  let activeIndex = -1;
  let items = [];

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keydown', onKeydown, true); // capture: run before compose.js's Enter handler
  textarea.addEventListener('blur', () => setTimeout(close, 150)); // let a click on the dropdown land first

  function onInput() {
    const query = currentQuery();
    if (query === null) return close();

    items = filterCommands(getCommands(), query);
    activeIndex = items.length > 0 ? 0 : -1;
    render();
  }

  // Slash commands only trigger as the very first thing in the message
  // (matching the CLI: `/foo` must lead the line), and only while still
  // typing the command name itself (no space yet).
  function currentQuery() {
    const pos = textarea.selectionStart;
    const text = textarea.value;
    if (!text.startsWith('/')) return null;
    const firstToken = text.slice(0, pos);
    if (/\s/.test(firstToken)) return null; // past the command name into its arguments
    const name = firstToken.slice(1);
    // Cockpit's `/ask <Name>: <text>` is client-side (ask-picker.js), not
    // an SDK slash command. Yield as soon as the token is exactly `ask`
    // so this list does not sit on top of the session-name picker.
    if (/^ask$/i.test(name)) return null;
    return name;
  }

  function render() {
    if (items.length === 0) return close();
    dropdown.innerHTML = '';
    items.forEach((command, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      li.className = i === activeIndex ? 'active' : '';

      const name = document.createElement('span');
      name.className = 'cmd-name';
      name.textContent = `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`;

      const desc = document.createElement('span');
      desc.className = 'cmd-desc';
      desc.textContent = command.description || '';

      li.append(name, desc);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in textarea, don't fire blur before we insert
        select(i);
      });
      dropdown.append(li);
    });
    dropdown.classList.add('show');
  }

  function select(i) {
    const command = items[i];
    if (!command) return;
    // Selecting resolves before any model turn (Spike C) - just plain
    // text, same as if it had been typed by hand. (/model is handled
    // separately by model-picker.js, which triggers on its own input match
    // rather than appearing in this list - see its module comment.)
    textarea.value = `/${command.name} `;
    const caret = textarea.value.length;
    textarea.setSelectionRange(caret, caret);
    close();
    textarea.focus();
  }

  function onKeydown(event) {
    if (!dropdown.classList.contains('show')) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      render();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation(); // don't let compose.js send the message
      select(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  function close() {
    dropdown.classList.remove('show');
    dropdown.innerHTML = '';
    items = [];
    activeIndex = -1;
  }
}
