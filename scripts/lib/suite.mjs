// Snapshot of the QA test directory: per file, a content hash, the number of
// expect() assertions, the number of skip/only/fixme markers and the test titles. Taken at run
// start (suite-baseline.json) and again after authoring (test-diff.mjs).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { countExpects, posix, testTitles, weakeningMarkers } from './common.mjs';

const TEST_FILE = /\.(?:[cm]?[jt]sx?)$/i;
const SKIP_DIRS = new Set(['node_modules', 'test-results', 'playwright-report', '.git']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full, out); } else if (TEST_FILE.test(name)) out.push(full);
  }
  return out;
}

export function snapshotSuite(worktree, testDir) {
  const files = {};
  for (const full of walk(path.join(worktree, testDir))) {
    const text = readFileSync(full, 'utf8');
    files[posix(path.relative(worktree, full))] = {
      sha: createHash('sha256').update(text).digest('hex').slice(0, 16),
      expects: countExpects(text),
      markers: weakeningMarkers(text),
      tests: testTitles(text),
    };
  }
  return { testDir: posix(testDir), files };
}
