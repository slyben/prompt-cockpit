// OS-specific default paths surfaced in the settings UI (currently just the
// screenshot folder for the @ file picker - see sdk-adapter.js's
// fileSuggestions). Computed server-side since this process runs on the
// same machine as the screenshots actually land on; the client never has to
// guess an OS from the browser's user-agent.
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// homedir() + 'Pictures' is only a guess - it breaks the moment OneDrive's
// Known Folder Move has redirected Pictures elsewhere (e.g. D:\...\OneDrive\
// Pictures), which is the default on most Microsoft-managed Windows installs.
// The registry actually knows where Pictures lives; ask it before falling
// back to the guess.
function windowsPicturesDir(home) {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'My Pictures'],
      { encoding: 'utf8' },
    );
    const match = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
    if (!match) return null;
    return match[1].trim().replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);
  } catch {
    return null; // reg.exe missing/blocked, key absent, non-Windows shim, etc - guess instead
  }
}

export function defaultScreenshotDir() {
  const home = os.homedir();
  switch (os.platform()) {
    case 'darwin':
      return path.join(home, 'Desktop', 'Screenshots');
    case 'win32':
      return path.join(windowsPicturesDir(home) || path.join(home, 'Pictures'), 'Screenshots');
    default: // linux and everything else GNOME/KDE-ish tend to agree on
      return path.join(home, 'Pictures', 'Screenshots');
  }
}
