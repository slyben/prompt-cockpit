// Grok MCP / plugin panel backend. Claude's Query handle talks to the
// live Agent SDK; Grok's equivalent is the CLI: `grok inspect --json` to
// list what this directory would load, and `grok mcp|plugin enable/disable`
// to persist the toggle. There is no live reconnect, and a running ACP
// session may not pick up a change until the next start.
import { parseJsonOutput, runGrokCommand } from './grok-cli.js';

export function pluginNameFromKey(pluginKey) {
  const raw = String(pluginKey || '');
  const at = raw.indexOf('@');
  return (at >= 0 ? raw.slice(0, at) : raw).trim();
}

function formatMcpSource(server) {
  const src = server && server.source;
  const vendor = server && server.vendor;
  if (!src && !vendor) return '';
  if (typeof src === 'string') return vendor ? `${vendor} · ${src}` : src;
  const type = src && src.type;
  const filePath = src && src.path;
  const label = vendor || type || '';
  if (filePath && label) return `${label} · ${filePath}`;
  return filePath || label || '';
}

function mcpEnabled(server) {
  if (server && server.enabled === false) return false;
  const status = server && server.compatibilityStatus;
  if (status === 'disabled' || status === 'blocked') return false;
  return true;
}

export function mcpServersFromInspect(inspect) {
  const list = inspect && Array.isArray(inspect.mcpServers) ? inspect.mcpServers : [];
  return list
    .filter((server) => server && typeof server.name === 'string' && server.name)
    .map((server) => {
      const enabled = mcpEnabled(server);
      return {
        name: server.name,
        status: enabled ? 'pending' : 'disabled',
        statusLabel: enabled ? 'configured' : 'disabled',
        source: formatMcpSource(server),
        canReconnect: false,
        error: null,
      };
    });
}

export function pluginsFromInspect(inspect) {
  const list = inspect && Array.isArray(inspect.plugins) ? inspect.plugins : [];
  return list
    .filter((plugin) => plugin && typeof plugin.name === 'string' && plugin.name)
    .map((plugin) => ({
      name: plugin.name,
      version: plugin.version || null,
      source: plugin.scope || 'grok',
      enabled: plugin.enabled !== false,
    }));
}

function skillInvocable(skill) {
  if (!skill || typeof skill.name !== 'string' || !skill.name) return false;
  if (skill.userInvocable === false) return false;
  const status = skill.compatibilityStatus;
  if (status === 'disabled' || status === 'blocked') return false;
  return true;
}

export function commandsFromInspect(inspect) {
  const list = inspect && Array.isArray(inspect.skills) ? inspect.skills : [];
  return list.filter(skillInvocable).map((skill) => ({
    name: skill.name,
    description: skill.description || '',
    argumentHint: skill.argumentHint || undefined,
    aliases: Array.isArray(skill.aliases) ? skill.aliases : undefined,
  }));
}

export function agentsFromInspect(inspect) {
  const list = inspect && Array.isArray(inspect.agents) ? inspect.agents : [];
  return list
    .filter((agent) => agent && typeof agent.name === 'string' && agent.name)
    .map((agent) => ({
      name: agent.name,
      description: agent.description || '',
    }));
}

export function createGrokExtensions({ cwd, runGrok } = {}) {
  const run = runGrok || ((args) => runGrokCommand(args, { cwd }));
  let cachedInspect = null;
  let inflight = null;

  async function inspect({ refresh = false } = {}) {
    if (!refresh && cachedInspect) return cachedInspect;
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(() => run(['inspect', '--json']))
      .then((raw) => {
        cachedInspect = parseJsonOutput(raw);
        return cachedInspect;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  function invalidate() {
    cachedInspect = null;
  }

  return {
    async mcpServerStatus() {
      return mcpServersFromInspect(await inspect());
    },
    async toggleMcpServer(name, enabled) {
      if (!name) throw new Error('MCP server name required');
      await run(['mcp', enabled ? 'enable' : 'disable', name]);
      invalidate();
    },
    async supportedCommands() {
      return commandsFromInspect(await inspect());
    },
    async supportedAgents() {
      return agentsFromInspect(await inspect());
    },
    async reloadPlugins() {
      const data = await inspect({ refresh: true });
      const plugins = pluginsFromInspect(data);
      return {
        commands: commandsFromInspect(data),
        agents: agentsFromInspect(data),
        plugins,
        mcpServers: [],
        error_count: 0,
      };
    },
    async setPluginEnabled(pluginKey, enabled) {
      const name = pluginNameFromKey(pluginKey);
      if (!name) throw new Error('plugin name required');
      await run(['plugin', enabled ? 'enable' : 'disable', name]);
      invalidate();
    },
  };
}
