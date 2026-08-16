// `/` slash-command autocomplete in the compose box, backed by the SDK's
// own supportedCommands() (plan Spike C: public Query method, no
// adapter/fallback needed like file_suggestions/get_workspace_diff - and
// "the command is resolved before the model turn, the cockpit just sends
// the text", so selecting one just inserts plain text, nothing special).
// Unlike file-picker.js this filters a client-cached list (app.js fetches
// once on connect and refreshes it on a commands_changed push) rather than
// hitting the server per keystroke - the full list is small and static
// almost all the time.

export function initCommandPicker({ textarea, dropdown, getCommands }) {
  let activeIndex = -1;
  let items = [];

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keydown', onKeydown, true); // capture: run before compose.js's Enter handler
  textarea.addEventListener('blur', () => setTimeout(close, 150)); // let a click on the dropdown land first

  function onInput() {
    const query = currentQuery();
    if (query === null) return close();

    const needle = query.toLowerCase();
    items = getCommands().filter((c) => matches(c, needle));
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
    return firstToken.slice(1);
  }

  function matches(command, needle) {
    if (!needle) return true;
    if (command.name.toLowerCase().startsWith(needle)) return true;
    return (command.aliases || []).some((a) => a.toLowerCase().startsWith(needle));
  }

  function render() {
    if (items.length === 0) return close();
    dropdown.innerHTML = '';
    items.forEach((command, i) => {
      const li = document.createElement('li');
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
    dropdown.style.display = 'block';
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
    if (dropdown.style.display !== 'block') return;
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
      close();
    }
  }

  function close() {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    items = [];
    activeIndex = -1;
  }
}
