// Path normalization for the guard. On this machine the same file shows up as
// `C:\a\b`, `C:/a/b` and `/c/a/b` (Git Bash), so every comparison goes through norm().
import path from 'node:path';

export function norm(p) {
  let s = String(p).replace(/\\/g, '/');
  const gitBash = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
  if (gitBash) s = `${gitBash[1]}:${gitBash[2] ?? '/'}`;
  s = path.posix.normalize(s);
  if (s.length > 1 && s.endsWith('/') && !/^[a-zA-Z]:\/$/.test(s)) s = s.slice(0, -1);
  // Windows file systems are case-insensitive; drive-letter paths compare lowercase.
  return /^[a-zA-Z]:\//.test(s) ? s.toLowerCase() : s;
}

export function isAbsolute(p) {
  const s = String(p).replace(/\\/g, '/');
  return s.startsWith('/') || /^[a-zA-Z]:\//.test(s);
}

export function resolveFrom(base, p) {
  if (!p) return null;
  return norm(isAbsolute(p) ? p : `${norm(base)}/${p}`);
}

export function samePath(a, b) {
  return norm(a) === norm(b);
}

export function isUnder(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

export function join(...parts) {
  return norm(parts.map((x) => String(x).replace(/\\/g, '/')).join('/'));
}
