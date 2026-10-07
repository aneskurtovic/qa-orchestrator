// qa-orchestrator recorder: SubagentStop hook.
//
// Appends one line per finished plugin agent to RUN/events.jsonl: which agent and
// step, how long it ran, its tool uses and tokens, and whether it ran in the
// foreground or the background. It also saves the agent's handback to
// RUN/outputs/<step>.md, which `validate.mjs --step` reads, so the orchestrator
// never retypes an agent's JSON (retyping cost minutes and tens of thousands of output tokens).
// Unlike the guard it never blocks and never prints a decision: a recording
// failure must not stop a run. It is dormant unless this session owns an active
// QA run.
//
// Everything comes from the subagent's own transcript, so it works for
// foreground and background dispatches alike. (An async Agent result carries no
// duration or usage; the Agent result's `totalTokens` is the context size at the
// last turn, not what the dispatch used.) Usage repeats on every content line of
// an API message, so each message id counts once.
//
// The handback is the last SubagentHandback call's message: agents send their JSON
// that way and then write a short summary, which is what `last_assistant_message`
// holds (verified live). Earlier runs ended on the fenced JSON itself.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isMain, writeTextAtomic } from '../scripts/lib/common.mjs';
import { findOwnedRun } from './lib/context.mjs';

const PREFIX = 'qa-orchestrator:';

// Tokens, tool uses and wall time of one subagent transcript (JSONL), plus its
// prompt and handback.
export function transcriptStats(file) {
  if (!file || !existsSync(file)) return null;
  const messages = new Map();
  const tools = new Set();
  let first = null;
  let last = null;
  let prompt = null;
  let handback = null;
  let fenced = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const t = Date.parse(entry.timestamp);
    if (Number.isFinite(t)) { first ??= t; last = t; }
    const msg = entry.message;
    if (prompt === null && entry.type === 'user' && typeof msg?.content === 'string') prompt = msg.content;
    if (msg?.role !== 'assistant') continue;
    if (msg.id && msg.usage) messages.set(msg.id, { model: msg.model ?? null, usage: msg.usage });
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (c.type === 'tool_use' && c.id) tools.add(c.id);
      if (c.type === 'tool_use' && c.name === 'SubagentHandback' && typeof c.input?.message === 'string') handback = c.input.message;
      if (c.type === 'text' && /```json/i.test(c.text ?? '')) fenced = c.text;
    }
  }
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const models = {};
  for (const { model, usage } of messages.values()) {
    tokens.input += usage.input_tokens ?? 0;
    tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
    tokens.output += usage.output_tokens ?? 0;
    if (model) models[model] = (models[model] ?? 0) + 1;
  }
  return {
    startedAt: first === null ? null : new Date(first).toISOString(),
    endedAt: last === null ? null : new Date(last).toISOString(),
    durationMs: first === null ? null : last - first,
    toolUses: tools.size,
    messages: messages.size,
    models,
    tokens,
    prompt,
    handback,
    fenced,
  };
}

// The brief prompt (brief.mjs) names the step: "… your complete task for step <step> of this QA run."
export function stepOf(prompt) {
  const step = /for step (\S+) of this QA run/.exec(String(prompt ?? ''))?.[1];
  return step && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(step) ? step : null;
}

// The candidate that carries the JSON: a SubagentHandback with only a summary must not win over
// fenced JSON the agent wrote as text, or validate fails and the agent is dispatched again (H5 counts it).
export function pickHandback({ handback, fenced } = {}, lastMessage) {
  const hasJson = (t) => typeof t === 'string' && (/```json/i.test(t) || /^\s*[[{]/.test(t));
  return [handback, fenced].find(hasJson) ?? handback ?? lastMessage ?? null;
}

// agent-<id>.jsonl sits next to agent-<id>.meta.json ({ agentType, requestShape, … }).
export function readMeta(transcript) {
  const file = String(transcript ?? '').replace(/\.jsonl$/i, '.meta.json');
  if (!transcript || !existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

export function eventFromTranscript(transcript, { agentType, now = new Date().toISOString(), extra = {}, stats = null } = {}) {
  const meta = readMeta(transcript);
  const type = String(agentType || meta.agentType || '');
  if (!type.startsWith(PREFIX)) return null;
  const { prompt, handback, fenced, ...rest } = stats ?? transcriptStats(transcript) ?? {};
  return {
    kind: 'agent',
    at: now,
    agent: type.slice(PREFIX.length),
    step: stepOf(prompt),
    description: meta.description ?? null,
    requestShape: meta.requestShape ?? null,
    ...rest,
    ...extra,
  };
}

// SubagentStop names the transcript directly (agent_transcript_path); older
// payloads only give the session transcript and the agent id.
export function subagentTranscript(input) {
  if (input.agent_transcript_path) return input.agent_transcript_path;
  if (!input.transcript_path || !input.agent_id) return null;
  return path.join(input.transcript_path.replace(/\.jsonl$/i, ''), 'subagents', `agent-${input.agent_id}.jsonl`);
}

export function record(input, env, append, save = writeTextAtomic) {
  const owned = findOwnedRun(input, env);
  if (!owned?.active?.runDir) return null;
  const transcript = subagentTranscript(input);
  const stats = transcriptStats(transcript) ?? {};
  const event = eventFromTranscript(transcript, { agentType: input.agent_type, stats, extra: { agentId: input.agent_id ?? null } });
  if (!event) return null;
  // A continued or re-dispatched agent overwrites its step's handback with the newer one.
  const handback = pickHandback(stats, input.last_assistant_message);
  if (event.step && typeof handback === 'string' && handback.trim()) {
    try {
      save(path.join(owned.active.runDir, 'outputs', `${event.step}.md`), `${handback.trim()}\n`);
      event.output = `outputs/${event.step}.md`;
    } catch { /* the orchestrator then saves it itself (qa-run playbook) */ }
  }
  append(path.join(owned.active.runDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  return event;
}

if (isMain(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try { record(JSON.parse(raw), process.env, appendFileSync); } catch { /* never block a run over telemetry */ }
    process.exit(0);
  });
}
