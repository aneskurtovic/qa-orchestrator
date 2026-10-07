// Shared helpers for the deterministic scripts. No dependencies.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withDefaults } from './config.mjs';

export class UsageError extends Error {}

// --name value / --flag  →  { name: 'value', flag: true, _: [positional…] }
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

export function need(args, ...names) {
  for (const n of names) if (args[n] === undefined || args[n] === true) throw new UsageError(`missing --${n.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
}

export function readJson(file, fallback) {
  if (fallback !== undefined && !existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Write to a temp file and rename, so readers never see a half-written file.
export function writeTextAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export const writeJsonAtomic = (file, data) => writeTextAtomic(file, `${JSON.stringify(data, null, 2)}\n`);

// Stable JSON (sorted keys) so equal content always hashes the same.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

export const posix = (p) => String(p).replace(/\\/g, '/');

// Is repo-relative `file` inside repo-relative directory `dir`?
export function inDir(file, dir) {
  const f = path.posix.normalize(posix(file));
  const d = path.posix.normalize(posix(dir)).replace(/\/$/, '');
  return !f.startsWith('../') && !path.posix.isAbsolute(f) && (f === d || f.startsWith(`${d}/`));
}

// Command runner. Scripts take it as a parameter so tests can inject a fake.
export function realRunner(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function mustRun(runner, cmd, args, opts) {
  const r = runner(cmd, args, opts);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r.stdout;
}

// The project's .qa/config.json with the defaults filled in (scripts/lib/config.mjs).
export function loadConfig(projectDir) {
  const file = path.join(projectDir, '.qa', 'config.json');
  if (!existsSync(file)) throw new UsageError(`No .qa/config.json in ${projectDir}. Run /qa-orchestrator:setup in Claude Code to create it.`);
  return withDefaults(readJson(file));
}

export const countExpects = (text) => (String(text).match(/\bexpect\s*(?:\.\s*\w+\s*)?\(/g) ?? []).length;
// Titles of test(…) calls (also test.only/skip/fixme/fail/slow), in file order. Not test.describe/step/beforeEach.
const TEST_TITLE = /\btest(?:\.(?:only|skip|fixme|fail|slow))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
export const testTitles = (text) => [...String(text).matchAll(TEST_TITLE)].map((m) => m[2]);
// Whether a test name from a plan (a bare title, or "describe › title" as Playwright reports it)
// names this title. Seen live: suite-impact wrote the trail, the baseline holds bare titles.
export const namesTest = (name, title) => name === title || String(name).endsWith(` › ${title}`);
export const weakeningMarkers =(text) => (String(text).match(/\.(?:skip|fixme|only)\s*\(/g) ?? []).length;

// Entry-point wrapper: prints JSON results, exits 2 on usage errors, 1 on failures.
export async function main(fn) {
  try {
    const result = await fn(parseArgs(process.argv.slice(2)));
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}

// True when the module is the entry point (node scripts/x.mjs), false when imported by tests.
// Lowercased: Windows may spell the drive letter either way.
export const isMain = (metaUrl) => Boolean(process.argv[1])
  && metaUrl.toLowerCase() === pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase();
