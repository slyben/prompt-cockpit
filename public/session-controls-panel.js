// Poll-on-open, no pushed events: git-guard/permission-rules are project-
// scoped settings.local.json values another tab/session may have changed
// since this modal was last open, and handshake trust is this tab's own
// session token, so both need a fresh check each time the modal opens.
export function initSessionControlsPanel({
  gitGuardModeEl,
  gitGuardErrorEl,
  getGitGuardMode,
  setGitGuardMode,
  handshakeStatusEl,
  handshakeInputEl,
  handshakeSaveBtnEl,
  handshakeErrorEl,
  getHandshakeStatus,
  saveHandshakeValue,
  permissionRulesListEl,
  getPermissionRules,
  revokePermissionRule,
}) {
  async function refreshGitGuardMode() {
    gitGuardErrorEl.hidden = true;
    const result = await getGitGuardMode();
    if (!result) return; // no session, or offline/blocked - select just keeps showing its last-known value
    gitGuardModeEl.value = result.mode;
  }

  gitGuardModeEl.addEventListener('change', async () => {
    const mode = gitGuardModeEl.value;
    try {
      await setGitGuardMode(mode);
      gitGuardErrorEl.hidden = true;
    } catch (err) {
      gitGuardErrorEl.textContent = `Couldn't save git commit guard setting: ${err.message || err}`;
      gitGuardErrorEl.hidden = false;
    }
  });

  async function refreshHandshakeStatus() {
    handshakeErrorEl.hidden = true;
    handshakeInputEl.value = '';
    const result = await getHandshakeStatus();
    if (!result) return;
    handshakeStatusEl.textContent = result.handshakeTrusted ? '✓ trusted' : '⚠ not trusted - paste the value below';
  }

  handshakeSaveBtnEl.addEventListener('click', async () => {
    const value = handshakeInputEl.value;
    try {
      const { trusted } = await saveHandshakeValue(value);
      handshakeStatusEl.textContent = trusted ? '✓ trusted' : '⚠ not trusted - value did not match';
      handshakeErrorEl.hidden = true;
    } catch (err) {
      handshakeErrorEl.textContent = `Couldn't save handshake value: ${err.message || err}`;
      handshakeErrorEl.hidden = false;
    }
  });

  async function refreshPermissionRulesList() {
    permissionRulesListEl.innerHTML = '';
    const result = await getPermissionRules().catch(() => null); // offline/blocked - list just stays empty until the next open, not fatal
    if (!result) return;
    for (const rule of result.allow || []) {
      const li = document.createElement('li');
      li.className = 'custom-folder-row'; // reuses the @-folder list's row/remove-button styling, same shape

      const label = document.createElement('span');
      label.className = 'cmd-name';
      label.textContent = rule;
      li.append(label);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'custom-folder-remove';
      removeBtn.textContent = '−';
      removeBtn.title = `Revoke always-allow for ${rule}`;
      removeBtn.addEventListener('click', async () => {
        await revokePermissionRule(rule);
        refreshPermissionRulesList();
      });
      li.append(removeBtn);

      permissionRulesListEl.append(li);
    }
  }

  return { refreshGitGuardMode, refreshHandshakeStatus, refreshPermissionRulesList };
}
