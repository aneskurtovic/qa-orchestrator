// Prints one compact line per logged hook payload (see guard.mjs, QA_HOOK_LOG=1).
// Usage: node hooks/test/summarize-log.mjs [path-to-hook-log.jsonl]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function findLog() {
  const root = join(homedir(), '.claude', 'plugins', 'data');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, 'hook-log.jsonl');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const file = process.argv[2] ?? findLog();
if (!file) { console.error('no hook-log.jsonl found'); process.exit(1); }
console.log(`log: ${file}`);

const short = (v) => (typeof v === 'string' ? v.slice(0, 70) : v);
for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
  const { event, payload: p } = JSON.parse(line);
  const input = p.tool_input
    ? Object.fromEntries(Object.entries(p.tool_input).map(([k, v]) => [k, short(v)]))
    : undefined;
  console.log(JSON.stringify({
    event, tool: p.tool_name, session: (p.session_id ?? '').slice(0, 8),
    agent_id: p.agent_id, agent_type: p.agent_type, input, keys: Object.keys(p).join(','),
  }));
}
