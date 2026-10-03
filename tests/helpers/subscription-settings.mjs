import { after } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Keep each test process independent of the operator's actual account config.
export function useTestSubscriptionSettings(claudeSubscriptions = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cockpit-test-settings-'));
  const filename = path.join(dir, 'settings.json');
  const previous = process.env.COCKPIT_SETTINGS_FILE;
  writeFileSync(filename, JSON.stringify({ claudeSubscriptions }));
  process.env.COCKPIT_SETTINGS_FILE = filename;
  after(() => {
    if (previous === undefined) delete process.env.COCKPIT_SETTINGS_FILE;
    else process.env.COCKPIT_SETTINGS_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return filename;
}
