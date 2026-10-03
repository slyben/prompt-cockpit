import { after } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Keep each test process independent of the operator's actual account config,
// including a shell-level CLAUDE_CONFIG_DIR that would otherwise make the
// default subscription share a config dir with a test subscription.
export function useTestSubscriptionSettings(claudeSubscriptions = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cockpit-test-settings-'));
  const filename = path.join(dir, 'settings.json');
  const previous = {
    COCKPIT_SETTINGS_FILE: process.env.COCKPIT_SETTINGS_FILE,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  writeFileSync(filename, JSON.stringify({ claudeSubscriptions }));
  process.env.COCKPIT_SETTINGS_FILE = filename;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, '.claude');
  after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return filename;
}
