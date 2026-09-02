// `@` autocomplete in the compose box, backed by GET
// /api/sessions/:id/file-suggestions, tagged { path, source: 'cwd' |
// <folder id> }. The left pane's virtual folders are a display grouping
// only - selecting a file always inserts `@<real path> `, never the
// folder name; both panes share one fetch per keystroke.

const DEBOUNCE_MS = 120;
const LOCAL_FOLDER = { label: 'Local folder', icon: '📁', source: 'cwd' };

function basename(p) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function initFilePicker({ textarea, dropdown, getSessionId, getSessionToken, getCustomFolders }) {
  const foldersEl = dropdown.querySelector('#fileSuggestionsFolders');
  const filesEl = dropdown.querySelector('#fileSuggestionsFiles');

  let debounceTimer = null;
  let isOpen = false;
  let allResults = []; // merged { path, source } for the current query, all sources
  let virtualFolders = [LOCAL_FOLDER]; // recomputed per fetch from getCustomFolders() - see fetchSuggestions
  let activeFolderIndex = 0; // which virtualFolders entry the right pane is showing
  let rightActiveIndex = -1; // keyboard-highlighted row within the right pane
  let atStart = -1; // index of the `@` that opened the current query

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keydown', onKeydown, true); // capture: run before compose.js's Enter handler
  textarea.addEventListener('blur', () => setTimeout(close, 150)); // let a click on the dropdown land first

  function onInput() {
    const token = currentToken();
    if (token === null) {
      close();
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fetchSuggestions(token), DEBOUNCE_MS);
  }

  function currentToken() {
    const pos = textarea.selectionStart;
    const text = textarea.value;
    const at = text.lastIndexOf('@', pos - 1);
    if (at === -1) return null;
    const between = text.slice(at + 1, pos);
    if (/\s/.test(between)) return null; // `@` from an earlier, already-finished token
    atStart = at;
    return between;
  }

  function currentRightItems() {
    const source = virtualFolders[activeFolderIndex].source;
    return allResults.filter((r) => r.source === source);
  }

  async function fetchSuggestions(query) {
    const id = getSessionId();
    if (!id) return;
    const customFolders = getCustomFolders ? getCustomFolders() : [];
    virtualFolders = [LOCAL_FOLDER, ...customFolders.map((f) => ({ label: f.label, icon: '📂', source: f.id }))];
    if (activeFolderIndex >= virtualFolders.length) activeFolderIndex = 0; // a folder got removed mid-session
    const params = new URLSearchParams({ q: query });
    if (customFolders.length > 0) {
      params.set('folders', JSON.stringify(customFolders.map((f) => ({ id: f.id, path: f.path }))));
    }
    const res = await fetch(`/api/sessions/${id}/file-suggestions?${params}`, {
      headers: { authorization: `Bearer ${getSessionToken()}` },
    });
    if (!res.ok) return close();
    allResults = await res.json();
    rightActiveIndex = currentRightItems().length > 0 ? 0 : -1;
    open();
    render();
  }

  function open() {
    isOpen = true;
    dropdown.classList.add('show');
  }

  function render() {
    renderFolders();
    renderFiles();
  }

  function renderFolders() {
    foldersEl.innerHTML = '';
    virtualFolders.forEach((folder, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === activeFolderIndex ? 'true' : 'false');
      li.textContent = `${folder.icon} ${folder.label}`;
      li.className = i === activeFolderIndex ? 'active' : '';
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in textarea, don't fire blur before a later click lands
        setActiveFolder(i);
      });
      foldersEl.append(li);
    });
  }

  function renderFiles() {
    filesEl.innerHTML = '';
    const files = currentRightItems();
    if (files.length === 0) {
      const li = document.createElement('li');
      li.className = 'suggestion-empty';
      li.textContent = 'No matches';
      filesEl.append(li);
      return;
    }
    files.forEach((item, i) => {
      const li = document.createElement('li');
      // An extra folder's own left-pane entry already names it ("Screenshots"),
      // so its files' insertion path - always `..\..\..\<folder>\<name>`, and
      // always exactly one level deep since extra folders aren't walked
      // recursively - is just noise here. Only the local-folder pane needs the
      // full relative path shown.
      li.textContent = item.source === 'cwd' ? item.path : basename(item.path);
      li.title = item.path; // full insertion path on hover, for anyone who wants to double-check
      li.setAttribute('role', 'option');
      li.className = item.source !== 'cwd' ? 'suggestion-screenshot' : ''; // class name predates multi-folder support - still just means "not the local folder"
      if (i === rightActiveIndex) {
        li.classList.add('active');
        li.setAttribute('aria-selected', 'true');
      } else {
        li.setAttribute('aria-selected', 'false');
      }
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in textarea, don't fire blur before we insert
        selectFile(i);
      });
      filesEl.append(li);
    });
  }

  function setActiveFolder(i) {
    activeFolderIndex = i;
    rightActiveIndex = currentRightItems().length > 0 ? 0 : -1;
    render();
  }

  function selectFile(i) {
    const item = currentRightItems()[i];
    if (item === undefined) return;
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, atStart);
    const after = textarea.value.slice(pos);
    const insertion = `@${item.path} `;
    textarea.value = before + insertion + after;
    const caret = before.length + insertion.length;
    textarea.setSelectionRange(caret, caret);
    close();
    textarea.focus();
  }

  function onKeydown(event) {
    if (!isOpen) return;
    const files = currentRightItems();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (files.length === 0) return;
      rightActiveIndex = Math.min(rightActiveIndex + 1, files.length - 1);
      renderFiles();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (files.length === 0) return;
      rightActiveIndex = Math.max(rightActiveIndex - 1, 0);
      renderFiles();
    } else if (event.key === 'ArrowLeft') {
      // Switches which folder's files the right pane shows - takes over
      // left/right while the picker is open rather than moving the caret
      // within the typed query. A click on either pane is always available
      // if you need to go back and edit the query itself.
      event.preventDefault();
      setActiveFolder(Math.max(activeFolderIndex - 1, 0));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setActiveFolder(Math.min(activeFolderIndex + 1, virtualFolders.length - 1));
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation(); // don't let compose.js send the message
      selectFile(rightActiveIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  function close() {
    isOpen = false;
    dropdown.classList.remove('show');
    foldersEl.innerHTML = '';
    filesEl.innerHTML = '';
    allResults = [];
    activeFolderIndex = 0;
    rightActiveIndex = -1;
  }
}
