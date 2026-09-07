import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandsFromSkills,
  codexRateLimitsToPanel,
  createCodexExtensions,
  mcpServersFromStatus,
  pluginsFromInstalled,
} from '../src/codex-extensions.js';

const CONFIG = {
  config: {
    mcp_servers: {
      ffind: { command: 'python', enabled: true },
      'off-server': { command: 'node', enabled: false },
      'needs-login': { command: 'auth-tool', enabled: true },
    },
  },
};

const MCP_STATUS = {
  data: [
    {
      name: 'ffind',
      authStatus: 'unsupported',
      serverInfo: { name: 'ffind', version: '1.0' },
      tools: { search: {} },
    },
    {
      name: 'needs-login',
      authStatus: 'notLoggedIn',
      serverInfo: null,
      tools: {},
    },
  ],
};

const PLUGINS = {
  marketplaces: [{
    name: 'local-marketplace',
    plugins: [
      {
        id: 'formatter@local-marketplace', name: 'formatter', version: '2.0.0',
        localVersion: null, installed: true, enabled: true, source: { type: 'remote' },
      },
      {
        id: 'available-only@local-marketplace', name: 'available-only', installed: false,
        enabled: false, source: { type: 'remote' },
      },
    ],
  }],
  marketplaceLoadErrors: [{ message: 'one marketplace failed' }],
};

const SKILLS = {
  data: [{ skills: [
    { name: 'visualize:visualize', description: 'long', enabled: true, interface: { shortDescription: 'visuals' } },
    { name: 'disabled-skill', description: 'off', enabled: false },
    { name: 'visualize:visualize', description: 'duplicate', enabled: true },
  ] }],
};

test('mcpServersFromStatus joins native status with config and normalizes panel state', () => {
  assert.deepEqual(mcpServersFromStatus(MCP_STATUS, CONFIG), [
    {
      name: 'ffind', enabled: true, status: 'connected', statusLabel: 'connected',
      source: 'python', canToggle: true, toggleDisabledReason: null, canReconnect: true, canAuthenticate: false, error: null,
    },
    {
      name: 'off-server', enabled: false, status: 'disabled', statusLabel: 'disabled',
      source: 'node', canToggle: true, toggleDisabledReason: null, canReconnect: false, canAuthenticate: false, error: null,
    },
    {
      name: 'needs-login', enabled: true, status: 'needs-auth', statusLabel: 'needs auth',
      source: 'auth-tool', canToggle: true, toggleDisabledReason: null, canReconnect: true, canAuthenticate: true, error: null,
    },
  ]);
});

test('mcpServersFromStatus uses startup failure notifications and rejects unsafe config names', () => {
  const status = mcpServersFromStatus(
    { data: [{ name: 'has.dot', authStatus: 'unsupported', tools: {}, serverInfo: null }] },
    { config: { mcp_servers: { 'has.dot': { command: 'tool', enabled: true } } } },
    new Map([['has.dot', { status: 'failed', error: 'could not start' }]]),
  );
  assert.deepEqual(status[0], {
    name: 'has.dot', enabled: true, status: 'failed', statusLabel: 'failed',
    source: 'tool', canToggle: false, toggleDisabledReason: 'This server name cannot be used as a settings key', canReconnect: false, canAuthenticate: false, error: 'could not start',
  });
});

test('mcpServersFromStatus keeps status-only servers read-only', () => {
  const status = mcpServersFromStatus(
    { data: [{ name: 'thread-only', authStatus: 'unsupported', tools: {}, serverInfo: { name: 'thread-only' } }] },
    { config: { mcp_servers: {} } },
  );
  assert.deepEqual(status[0], {
    name: 'thread-only', enabled: true, status: 'connected', statusLabel: 'connected',
    source: '', canToggle: false, toggleDisabledReason: 'This server is attached to the thread but is not in editable settings', canReconnect: false, canAuthenticate: false, error: null,
  });
});

test('MCP OAuth remains available for configured names that are unsafe as config key paths', () => {
  const status = mcpServersFromStatus(
    { data: [{ name: 'github.enterprise', authStatus: 'notLoggedIn', tools: {}, serverInfo: null }] },
    { config: { mcp_servers: { 'github.enterprise': { command: 'tool', enabled: true } } } },
  );
  assert.equal(status[0].canToggle, false);
  assert.equal(status[0].canAuthenticate, true);
});

test('pluginsFromInstalled flattens installed plugin summaries and keeps ids for config writes', () => {
  assert.deepEqual(pluginsFromInstalled(PLUGINS), [{
    id: 'formatter@local-marketplace', name: 'formatter', version: '2.0.0',
    source: 'local-marketplace', enabled: true, restartRequired: true,
    canToggle: true, toggleDisabledReason: null,
  }]);
});

test('pluginsFromInstalled marks synthesized local-path ids as non-toggleable', () => {
  const [plugin] = pluginsFromInstalled({ marketplaces: [{
    plugins: [{ name: 'local-plugin', source: { type: 'local', path: 'C:\\plugins\\local-plugin' } }],
  }] });
  assert.equal(plugin.id, 'local-plugin@C:\\plugins\\local-plugin');
  assert.equal(plugin.canToggle, false);
  assert.equal(plugin.toggleDisabledReason, 'This plugin id cannot be used as a settings key');
});

test('commandsFromSkills keeps enabled skills, descriptions, and unique names', () => {
  assert.deepEqual(commandsFromSkills(SKILLS), [{
    name: 'visualize:visualize', description: 'visuals',
  }]);
});

test('codexRateLimitsToPanel maps native primary/secondary windows to the stats shape', () => {
  assert.deepEqual(codexRateLimitsToPanel({ rateLimits: {
    primary: { usedPercent: 14, resetsAt: 1788796894 },
    secondary: { usedPercent: 18, resetsAt: 1789335920 },
  } }), {
    five_hour: { utilization: 14, resets_at: 1788796894000 },
    seven_day: { utilization: 18, resets_at: 1789335920000 },
  });
  assert.equal(codexRateLimitsToPanel({ rateLimits: {} }), null);
});

test('createCodexExtensions uses native MCP/plugin methods and validates writes', async () => {
  const calls = [];
  let notificationHandler;
  const manager = {
    subscribe(handler) {
      notificationHandler = handler;
      return () => { notificationHandler = null; };
    },
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'config/read') return CONFIG;
      if (method === 'mcpServerStatus/list') return MCP_STATUS;
      if (method === 'plugin/installed') return PLUGINS;
      if (method === 'skills/list') return SKILLS;
      if (method === 'mcpServer/oauthLogin') return { authorizationUrl: 'https://example.com/oauth' };
      return {};
    },
  };
  const ext = createCodexExtensions({ cwd: 'D:\\repo', manager, getThreadId: () => 'thread-1' });

  notificationHandler('mcpServer/startupStatus/updated', {
    name: 'ffind', status: 'failed', error: 'gone', threadId: 'thread-1',
  });
  assert.equal((await ext.mcpServerStatus())[0].status, 'failed');
  assert.equal((await ext.supportedCommands())[0].name, 'visualize:visualize');
  assert.equal((await ext.reloadPlugins()).plugins[0].id, 'formatter@local-marketplace');
  assert.equal(await ext.codexRateLimits(), null);
  assert.equal(await ext.mcpOauthLogin('needs-login'), 'https://example.com/oauth');

  await ext.toggleMcpServer('ffind', false);
  await ext.reconnectMcpServer('ffind');
  await ext.setPluginEnabled('formatter@local-marketplace', false);
  await assert.rejects(() => ext.toggleMcpServer('missing', false), /unknown Codex MCP server/);
  await assert.rejects(() => ext.setPluginEnabled('missing@local-marketplace', false), /unknown Codex plugin/);

  assert.deepEqual(calls.filter(([method]) => method === 'config/value/write'), [
    ['config/value/write', {
      keyPath: 'mcp_servers.ffind.enabled', mergeStrategy: 'upsert', value: false,
    }],
    ['config/value/write', {
      keyPath: 'plugins.formatter@local-marketplace.enabled', mergeStrategy: 'upsert', value: false,
    }],
  ]);
  assert.equal(calls.filter(([method]) => method === 'config/mcpServer/reload').length, 2);
  assert.deepEqual(calls.find(([method]) => method === 'mcpServer/oauthLogin'), [
    'mcpServer/oauthLogin', { name: 'needs-login', threadId: 'thread-1' },
  ]);
  ext.dispose();
  assert.equal(notificationHandler, null);
});

test('mcp startup notifications stay scoped to the requesting Codex thread', () => {
  const result = { data: [{ name: 'ffind', authStatus: 'unsupported', serverInfo: null, tools: {} }] };
  const config = { config: { mcp_servers: { ffind: { command: 'python', enabled: true } } } };
  const states = new Map([
    ['thread-1\0ffind', { status: 'failed', error: 'thread one failed' }],
    ['thread-2\0ffind', { status: 'ready', error: null }],
  ]);
  assert.equal(mcpServersFromStatus(result, config, states, 'thread-1')[0].status, 'failed');
  assert.equal(mcpServersFromStatus(result, config, states, 'thread-2')[0].status, 'connected');
});
