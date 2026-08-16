import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseJsonOutput, runGrokCommand } from '../src/grok-cli.js';
import {
  agentsFromInspect,
  commandsFromInspect,
  createGrokExtensions,
  mcpServersFromInspect,
  pluginNameFromKey,
  pluginsFromInspect,
} from '../src/grok-extensions.js';

const INSPECT = {
  mcpServers: [
    {
      name: 'ffind',
      transport: 'stdio',
      target: 'python',
      source: { type: 'claudeJson', path: 'C:\\Users\\x\\.claude.json' },
      compatibilityStatus: 'enabled',
      vendor: 'claude',
    },
    {
      name: 'off-server',
      compatibilityStatus: 'disabled',
      source: { type: 'toml', path: 'C:\\Users\\x\\.grok\\config.toml' },
      vendor: 'grok',
    },
  ],
  plugins: [
    { name: 'playwright', scope: 'user', enabled: true, version: '1.2.0' },
    { name: 'quiet', scope: 'project', enabled: false },
  ],
  skills: [
    { name: 'caveman', description: 'talk like caveman', userInvocable: true, compatibilityStatus: 'enabled' },
    { name: 'hidden', description: 'not a slash command', userInvocable: false },
    { name: 'broken', description: 'off', userInvocable: true, compatibilityStatus: 'disabled' },
  ],
  agents: [
    { name: 'explore', description: 'read-only explorer' },
    { name: 'plan', description: 'architect' },
  ],
};

test('parseJsonOutput accepts bare JSON and JSON after log noise', () => {
  assert.deepEqual(parseJsonOutput('{"ok":true}'), { ok: true });
  assert.deepEqual(parseJsonOutput('debug: starting\n[{"name":"a"}]'), [{ name: 'a' }]);
  assert.throws(() => parseJsonOutput('not json'), /no JSON/);
});

test('mcpServersFromInspect maps inspect rows to panel status', () => {
  const servers = mcpServersFromInspect(INSPECT);
  assert.equal(servers.length, 2);
  assert.deepEqual(servers[0], {
    name: 'ffind',
    status: 'pending',
    statusLabel: 'configured',
    source: 'claude · C:\\Users\\x\\.claude.json',
    canReconnect: false,
    error: null,
  });
  assert.equal(servers[1].name, 'off-server');
  assert.equal(servers[1].status, 'disabled');
  assert.equal(servers[1].canReconnect, false);
});

test('pluginsFromInspect keeps name/scope/enabled for the panel toggle', () => {
  const plugins = pluginsFromInspect(INSPECT);
  assert.deepEqual(plugins, [
    { name: 'playwright', version: '1.2.0', source: 'user', enabled: true },
    { name: 'quiet', version: null, source: 'project', enabled: false },
  ]);
  assert.equal(pluginNameFromKey('playwright@user'), 'playwright');
  assert.equal(pluginNameFromKey('playwright'), 'playwright');
});

test('commandsFromInspect keeps invocable skills; agentsFromInspect keeps name/description', () => {
  const commands = commandsFromInspect(INSPECT);
  assert.deepEqual(commands, [{ name: 'caveman', description: 'talk like caveman', argumentHint: undefined, aliases: undefined }]);
  const agents = agentsFromInspect(INSPECT);
  assert.deepEqual(agents, [
    { name: 'explore', description: 'read-only explorer' },
    { name: 'plan', description: 'architect' },
  ]);
});

test('createGrokExtensions lists from inspect and toggles via grok mcp/plugin', async () => {
  const calls = [];
  const ext = createGrokExtensions({
    cwd: 'D:\\proj',
    runGrok: async (args) => {
      calls.push(args);
      if (args[0] === 'inspect') return JSON.stringify(INSPECT);
      return '';
    },
  });

  const servers = await ext.mcpServerStatus();
  assert.equal(servers[0].name, 'ffind');
  await ext.toggleMcpServer('ffind', false);
  const reloaded = await ext.reloadPlugins();
  assert.equal(reloaded.plugins[0].name, 'playwright');
  await ext.setPluginEnabled('playwright@user', true);

  const commands = await ext.supportedCommands();
  const agents = await ext.supportedAgents();
  assert.equal(commands[0].name, 'caveman');
  assert.equal(agents[0].name, 'explore');

  assert.deepEqual(calls, [
    ['inspect', '--json'],
    ['mcp', 'disable', 'ffind'],
    ['inspect', '--json'],
    ['plugin', 'enable', 'playwright'],
    ['inspect', '--json'],
  ]);
});

test('runGrokCommand returns stdout and rejects a non-zero exit', async () => {
  function spawnOk(command, args) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    assert.deepEqual(args, ['inspect', '--json']);
    queueMicrotask(() => {
      proc.stdout.emit('data', '{"ok":1}');
      proc.emit('close', 0);
    });
    return proc;
  }
  const out = await runGrokCommand(['inspect', '--json'], {
    spawnImpl: spawnOk,
    resolveBin: () => 'grok.exe',
  });
  assert.equal(out, '{"ok":1}');

  function spawnFail() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    queueMicrotask(() => {
      proc.stderr.emit('data', 'no such server');
      proc.emit('close', 1);
    });
    return proc;
  }
  await assert.rejects(
    runGrokCommand(['mcp', 'disable', 'missing'], { spawnImpl: spawnFail, resolveBin: () => 'grok.exe' }),
    /no such server/,
  );

  await assert.rejects(
    runGrokCommand(['mcp', 'disable', 'x & calc'], {
      spawnImpl: () => { throw new Error('should not spawn'); },
      resolveBin: () => 'grok.exe',
    }),
    /invalid grok argument/,
  );
});
