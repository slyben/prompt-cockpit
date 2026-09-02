// `/model` picker: intercepted locally (Query.supportedModels()/
// setModel() are public SDK methods) rather than sent as a slash command,
// since it needs an actual picker, not a message turn. Matches its own
// input pattern rather than going through command-picker.js's list,
// since /model is a built-in that may not show up in supportedCommands().
export function initModelPicker({ textarea, dropdown, fetchModels, getCurrentModel, onSelect }) {
  let activeIndex = -1;
  let items = [];
  let open = false;

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keydown', onKeydown, true); // capture: run before compose.js's Enter handler
  textarea.addEventListener('blur', () => setTimeout(close, 150)); // let a click on the dropdown land first

  function onInput() {
    const query = currentQuery();
    // Requires at least one letter typed past the slash ("/m", not bare
    // "/") so a lone "/" only opens command-picker's full list, not both
    // dropdowns stacked on top of each other.
    if (!query || !'model'.startsWith(query.toLowerCase())) return close();
    load();
  }

  // Same rule as command-picker.js's currentQuery: only while still typing
  // the command name itself, no space yet.
  function currentQuery() {
    const pos = textarea.selectionStart;
    const text = textarea.value;
    if (!text.startsWith('/')) return null;
    const firstToken = text.slice(0, pos);
    if (/\s/.test(firstToken)) return null;
    return firstToken.slice(1);
  }

  async function load() {
    open = true;
    if (items.length === 0) {
      dropdown.innerHTML = '';
      const loading = document.createElement('li');
      loading.className = 'cmd-desc';
      loading.textContent = 'Loading models…';
      dropdown.append(loading);
      dropdown.classList.add('show');
    }
    try {
      items = await fetchModels();
    } catch (err) {
      dropdown.innerHTML = '';
      const errLi = document.createElement('li');
      errLi.className = 'cmd-desc';
      errLi.textContent = `Could not load models: ${err.message || err}`;
      dropdown.append(errLi);
      return;
    }
    if (!open) return; // closed (e.g. blur) while the fetch was in flight
    activeIndex = items.length > 0 ? 0 : -1;
    render();
  }

  function render() {
    const current = getCurrentModel();
    dropdown.innerHTML = '';
    items.forEach((model, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      li.className = i === activeIndex ? 'active' : '';

      const name = document.createElement('span');
      name.className = 'cmd-name' + (model.value === current || model.resolvedModel === current ? ' current' : '');
      name.textContent = model.displayName || model.value;

      const desc = document.createElement('span');
      desc.className = 'cmd-desc';
      desc.textContent = model.description || '';

      li.append(name, desc);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in textarea, don't fire blur before we act
        select(i);
      });
      dropdown.append(li);
    });
    dropdown.classList.add('show');
  }

  function select(i) {
    const model = items[i];
    if (!model) return;
    onSelect(model.value);
    textarea.value = ''; // nothing to send - the switch happened via the API call, not a message
    close();
    textarea.focus();
  }

  function onKeydown(event) {
    if (!open) return;
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
    open = false;
    dropdown.classList.remove('show');
    dropdown.innerHTML = '';
    items = [];
    activeIndex = -1;
  }
}
