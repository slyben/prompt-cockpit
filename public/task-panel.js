// Task list panel (TaskCreate/TaskUpdate/TaskList tool calls) - docked
// above compose, same toggle-button/settings-checkbox-mirror pattern as
// turn-chart.js. Unlike turn-chart.js there's nothing to fetch or compute
// here: session-registry.js derives the task list server-side from
// watching Task* tool calls in the message stream and pushes a full
// snapshot (cockpit:tasks) on every real change, including once on attach -
// this module just renders whatever it's handed.

// pending/in_progress first, completed last - otherwise a long-running
// session's list reads bottom-heavy with finished work pushing what's
// actually still active off the visible area.
const STATUS_ORDER = { in_progress: 0, pending: 1, completed: 2 };

export function initTaskPanel({ panel, listEl }) {
  let enabled = false;
  let tasks = [];

  function setEnabled(next) {
    enabled = next;
    panel.style.display = enabled ? 'block' : 'none';
    if (enabled) render();
  }

  // Called on every cockpit:tasks push - see app.js. Always the full
  // current list (never a delta), so this can just replace and re-render.
  function setTasks(next) {
    tasks = next || [];
    if (enabled) render();
  }

  function reset() {
    tasks = [];
    if (enabled) render();
  }

  function render() {
    listEl.innerHTML = '';
    if (!tasks.length) {
      const empty = document.createElement('li');
      empty.className = 'task-empty';
      empty.textContent = 'No tasks yet.';
      listEl.append(empty);
      return;
    }
    [...tasks]
      .sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3))
      .forEach((task) => listEl.append(renderTask(task)));
  }

  function renderTask(task) {
    const li = document.createElement('li');
    li.className = 'task-row';

    const dot = document.createElement('span');
    dot.className = `task-status task-status-${task.status}`;
    dot.title = task.status;
    li.append(dot);

    const subject = document.createElement('span');
    subject.className = task.status === 'completed' ? 'task-subject task-subject-done' : 'task-subject';
    subject.textContent = task.subject;
    li.append(subject);

    if (task.owner) {
      const owner = document.createElement('span');
      owner.className = 'task-owner';
      owner.textContent = task.owner;
      li.append(owner);
    }

    if (task.blockedBy && task.blockedBy.length) {
      const blocked = document.createElement('span');
      blocked.className = 'task-blocked';
      blocked.textContent = `blocked by ${task.blockedBy.length}`;
      li.append(blocked);
    }

    return li;
  }

  return { setEnabled, setTasks, reset };
}
