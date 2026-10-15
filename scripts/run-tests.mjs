/**
 * Test runner.
 *
 * The tests exercise the real store (votes, community decks, runs), and the
 * store reads `DATA_FILE` when it is first imported. Pointing that at a
 * throwaway file here — before any test file loads — keeps a test run from
 * writing votes or uploaded decks into the deployment's real data.
 *
 *   npm test            (this wrapper, isolated store)
 *   node --test tests/  (direct, uses ./data/store.json — avoid)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-daily-tests-'));
const dataFile = path.join(dir, 'store.json');

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2, 3).length ? process.argv.slice(2) : ['tests/']], {
  stdio: 'inherit',
  env: { ...process.env, DATA_FILE: dataFile },
});

child.on('exit', (code) => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
