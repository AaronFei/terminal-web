// Ensure node-pty's prebuilt `spawn-helper` is executable.
//
// On macOS/Linux, node-pty ships a prebuilt `spawn-helper` binary that the
// library exec()s to launch your shell. npm's package extraction (notably
// under npm 11's locked-down install-script handling) can land that file
// without its execute bit, which makes pty.spawn() fail with
// "posix_spawnp failed". node-pty's own post-install only touches
// build/Release (a from-source build), not the prebuilt copy, so we fix the
// prebuilt binary's mode here as a project postinstall.
//
// No-op on Windows (uses conpty, no spawn-helper) and harmless if the file is
// absent (e.g. a from-source build was used instead).
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.platform === 'win32') {
  process.exit(0);
}

let ptyRoot;
try {
  const require = createRequire(import.meta.url);
  // Resolve via the package's manifest so we find its install location
  // regardless of hoisting.
  ptyRoot = dirname(require.resolve('node-pty/package.json'));
} catch {
  // node-pty not installed (or not resolvable) — nothing to do.
  process.exit(0);
}

const candidates = [
  join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  join(ptyRoot, 'build', 'Release', 'spawn-helper'),
];

for (const file of candidates) {
  if (!existsSync(file)) continue;
  try {
    const mode = statSync(file).mode;
    // Add execute bits for user/group/other (preserve existing read/write).
    const desired = mode | 0o111;
    if (mode !== desired) {
      chmodSync(file, desired);
      console.log(`fix-pty-perms: made executable -> ${file}`);
    }
  } catch (err) {
    console.warn(`fix-pty-perms: could not chmod ${file}: ${err.message}`);
  }
}
