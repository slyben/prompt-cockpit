// Codex app-server backed extensions used by the settings panels.  The
// app-server owns Codex's config and plugin stores, so these methods keep
// their writes behind the same authenticated session handle as turns.

function configuredMcpServers(configResult) {
  const servers = configResult?.config?.mcp_servers;
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {};
}

function safeConfigName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name);
}

function commandSource(config) {
  return typeof config?.command === 'string' ? config.command : '';
}

function startupStateFor(states, name, threadId = null) {
  if (states instanceof Map) {
    const scoped = threadId ? states.get(`${threadId}\0${name}`) : null;
    return scoped || states.get(`*\0${name}`) || states.get(name) || null;
  }
  return states && typeof states === 'object' ? states[name] || null : null;
}

function mcpRowStatus(row, config, startupState) {
  if (config?.enabled === false) return { status: 'disabled', statusLabel: 'disabled' };
  if (startupState?.status === 'failed') return { status: 'failed', statusLabel: 'failed' };
  if (row?.authStatus === 'notLoggedIn') return { status: 'needs-auth', statusLabel: 'needs auth' };
  const connected = startupState?.status === 'ready'
    || row?.serverInfo
    || Object.keys(row?.tools || {}).length > 0;
  return connected
    ? { status: 'connected', statusLabel: 'connected' }
    : { status: 'pending', statusLabel: 'configured' };
}

// Convert the native status/config pair to the provider-neutral shape the
// existing MCP panel already renders for Claude and Grok.
export function mcpServersFromStatus(result, configResult = {}, startupStates = new Map(), threadId = null) {
  const configured = configuredMcpServers(configResult);
  const reported = Array.isArray(result) ? result : (result?.data || []);
  const byName = new Map(reported.filter((row) => row?.name).map((row) => [row.name, row]));
  const names = [...new Set([...Object.keys(configured), ...byName.keys()])];

  return names.map((name) => {
    const row = byName.get(name) || {};
    const config = configured[name] || {};
    const startupState = startupStateFor(startupStates, name, threadId);
    const state = mcpRowStatus(row, config, startupState);
    // A status-only row can be a server attached to the thread but absent
    // from the editable config file. Keep it visible, but never offer a
    // write that configuredServer() will reject.
    const canToggle = Object.hasOwn(configured, name) && safeConfigName(name);
    return {
      name,
      enabled: config.enabled !== false,
      ...state,
      source: commandSource(config),
      canToggle,
      toggleDisabledReason: canToggle ? null
        : Object.hasOwn(configured, name)
          ? 'This server name cannot be used as a settings key'
          : 'This server is attached to the thread but is not in editable settings',
      canReconnect: canToggle && state.status !== 'disabled',
      canAuthenticate: Object.hasOwn(configured, name) && state.status === 'needs-auth',
      error: startupState?.error || null,
    };
  });
}

function pluginSourceLabel(marketplace, source) {
  if (marketplace?.name) return marketplace.name;
  if (!source || typeof source !== 'object') return '';
  if (source.type === 'local') return source.path || 'local';
  if (source.type === 'git') return source.url || 'git';
  if (source.type === 'npm') return source.package || 'npm';
  return source.type || '';
}

// `plugin/installed` nests summaries under marketplaces while the shared
// panel wants one flat row per installed plugin.
export function pluginsFromInstalled(result) {
  const rows = [];
  for (const marketplace of result?.marketplaces || []) {
    for (const plugin of marketplace?.plugins || []) {
      if (!plugin?.name || plugin.installed === false) continue;
      const source = pluginSourceLabel(marketplace, plugin.source);
      const id = plugin.id || `${plugin.name}@${source}`;
      const canToggle = Boolean(source) && canWritePluginId(id);
      rows.push({
        id,
        name: plugin.name,
        version: plugin.localVersion || plugin.version || null,
        source,
        enabled: plugin.enabled !== false,
        restartRequired: true,
        canToggle,
        toggleDisabledReason: canToggle ? null
          : !source
            ? 'This plugin has no editable source identifier'
            : 'This plugin id cannot be used as a settings key',
      });
    }
  }
  return rows;
}

// Codex's skills/list is the closest native equivalent to the slash-command
// roster.  It is deliberately kept separate from plugin listing because
// system/user skills can exist without a plugin.
export function commandsFromSkills(result) {
  const commands = [];
  const seen = new Set();
  for (const entry of result?.data || []) {
    for (const skill of entry?.skills || []) {
      if (!skill?.name || skill.enabled === false || seen.has(skill.name)) continue;
      seen.add(skill.name);
      commands.push({
        name: skill.name,
        description: skill.interface?.shortDescription || skill.shortDescription || skill.description || '',
      });
    }
  }
  return commands;
}

function rateLimitWindow(window) {
  const utilization = Number(window?.usedPercent);
  if (!Number.isFinite(utilization)) return null;
  const resetsAt = Number(window?.resetsAt);
  return {
    utilization,
    resets_at: Number.isFinite(resetsAt) ? resetsAt * 1000 : null,
  };
}

// Keep the existing stats chip provider-neutral. Codex calls the two windows
// primary/secondary and reports reset times in epoch seconds; the shared UI
// uses five_hour and epoch milliseconds.
export function codexRateLimitsToPanel(result) {
  const snapshot = result?.rateLimits || result;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const fiveHour = rateLimitWindow(snapshot.primary);
  const sevenDay = rateLimitWindow(snapshot.secondary);
  if (!fiveHour && !sevenDay) return null;
  return { five_hour: fiveHour, seven_day: sevenDay };
}

function requireSafePluginId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9@_-]+$/.test(id)) {
    throw new Error(`invalid Codex plugin id${id ? `: ${id}` : ''}`);
  }
  return id;
}

function canWritePluginId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9@_-]+$/.test(id);
}

export function createCodexExtensions({ cwd, manager, getThreadId = () => null } = {}) {
  if (!manager?.request) throw new Error('Codex app-server manager required');
  const startupStates = new Map();
  const unsubscribe = manager.subscribe?.((method, params) => {
    if (method !== 'mcpServer/startupStatus/updated' || !params?.name) return;
    const key = params.threadId ? `${params.threadId}\0${params.name}` : `*\0${params.name}`;
    startupStates.set(key, { status: params.status, error: params.error || null });
  });

  async function readConfig() {
    return manager.request('config/read', { cwd, includeLayers: false });
  }

  async function listMcpStatus() {
    const rows = [];
    let cursor;
    do {
      const params = { limit: 100, detail: 'full' };
      const threadId = getThreadId();
      if (threadId) params.threadId = threadId;
      if (cursor) params.cursor = cursor;
      const page = await manager.request('mcpServerStatus/list', params);
      rows.push(...(page?.data || []));
      cursor = page?.nextCursor || null;
    } while (cursor);
    return rows;
  }

  async function configuredServer(name) {
    if (!name) throw new Error('MCP server name required');
    if (!safeConfigName(name)) throw new Error(`cannot edit Codex MCP server "${name}" safely`);
    const config = await readConfig();
    const servers = configuredMcpServers(config);
    if (!Object.hasOwn(servers, name)) throw new Error(`unknown Codex MCP server: ${name}`);
    return config;
  }

  async function configuredAuthServer(name) {
    if (!name) throw new Error('MCP server name required');
    const config = await readConfig();
    const servers = configuredMcpServers(config);
    if (!Object.hasOwn(servers, name)) throw new Error(`unknown Codex MCP server: ${name}`);
    return config;
  }

  async function reloadMcp() {
    await manager.request('config/mcpServer/reload', null);
  }

  async function mcpServerStatus() {
    const [rows, config] = await Promise.all([listMcpStatus(), readConfig()]);
    return mcpServersFromStatus(rows, config, startupStates, getThreadId());
  }

  async function toggleMcpServer(name, enabled) {
    await configuredServer(name);
    await manager.request('config/value/write', {
      keyPath: `mcp_servers.${name}.enabled`,
      mergeStrategy: 'upsert',
      value: Boolean(enabled),
    });
    await reloadMcp();
  }

  async function reconnectMcpServer(name) {
    await configuredServer(name);
    await reloadMcp();
  }

  async function mcpOauthLogin(name) {
    // OAuth receives the server name as a JSON-RPC value, not as a dotted
    // config key path, so valid names that are intentionally read-only for
    // toggle writes can still authenticate safely.
    await configuredAuthServer(name);
    const threadId = getThreadId();
    const result = await manager.request('mcpServer/oauthLogin', {
      name,
      ...(threadId ? { threadId } : {}),
    });
    if (!result?.authorizationUrl) throw new Error(`Codex did not return an authorization URL for MCP server "${name}"`);
    return result.authorizationUrl;
  }

  async function installedPlugins() {
    return manager.request('plugin/installed', { cwds: [cwd] });
  }

  async function reloadPlugins() {
    const result = await installedPlugins();
    return {
      commands: [],
      agents: [],
      plugins: pluginsFromInstalled(result),
      mcpServers: [],
      error_count: Array.isArray(result?.marketplaceLoadErrors) ? result.marketplaceLoadErrors.length : 0,
    };
  }

  async function setPluginEnabled(pluginKey, enabled) {
    const result = await installedPlugins();
    const plugins = pluginsFromInstalled(result);
    const plugin = plugins.find((entry) => entry.id === pluginKey || `${entry.name}@${entry.source}` === pluginKey);
    if (!plugin) throw new Error(`unknown Codex plugin: ${pluginKey}`);
    if (plugin.canToggle === false) throw new Error(plugin.toggleDisabledReason || 'This Codex plugin cannot be toggled safely');
    const id = requireSafePluginId(plugin.id);
    await manager.request('config/value/write', {
      keyPath: `plugins.${id}.enabled`,
      mergeStrategy: 'upsert',
      value: Boolean(enabled),
    });
  }

  async function supportedCommands() {
    try {
      const result = await manager.request('skills/list', { cwds: [cwd], forceReload: false });
      return commandsFromSkills(result);
    } catch {
      return [];
    }
  }

  async function codexRateLimits() {
    const result = await manager.request('account/rateLimits/read', null);
    return codexRateLimitsToPanel(result);
  }

  return {
    mcpServerStatus,
    toggleMcpServer,
    reconnectMcpServer,
    mcpOauthLogin,
    reloadPlugins,
    setPluginEnabled,
    supportedCommands,
    supportedAgents: async () => [],
    codexRateLimits,
    dispose: () => unsubscribe?.(),
  };
}
