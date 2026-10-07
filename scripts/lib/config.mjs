// .qa/config.json (docs/design.md §3): defaults for the optional keys, and the checks for the
// required ones. The scripts (loadConfig) and the guard (loadContext) both apply withDefaults, so
// they always see the same config. No other imports: the guard loads this file on every tool call.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_LIMITS = { maxPlanRevisions: 2, maxTestLaunches: 7 };
export const DEFAULT_INSTALL = 'npm ci --prefer-offline --no-audit --no-fund';

// The keys the plugin reads. Anything else in the file is reported as unused.
const KNOWN = {
  jira: ['projectKey', 'cloudId', 'mcpToolPrefix', 'statuses', 'allowedTransitionIds'],
  git: ['integrationBranch', 'devBranchKeyPattern', 'protectedBranches'],
  stack: ['composeFile', 'project', 'health', 'healthTimeoutSec', 'shaCheck'],
  qa: ['testDir', 'apiTestDir', 'playwrightConfig', 'protectedFiles', 'baseUrl', 'apiUrl', 'env', 'installCommand',
    'conventionsDocs', 'capabilities', 'knownDrift', 'driftProbeEvery'],
  suites: null,
  routes: null,
  criticalAreas: null,
  limits: Object.keys(DEFAULT_LIMITS),
};

const uniq = (xs) => [...new Set(xs)];

export function withDefaults(raw) {
  const c = raw ?? {};
  const jira = c.jira ?? {};
  const git = c.git ?? {};
  const stack = c.stack ?? {};
  const qa = c.qa ?? {};
  return {
    ...c,
    jira: { mcpToolPrefix: 'mcp__atlassian__', allowedTransitionIds: [], ...jira, statuses: { ...(jira.statuses ?? {}) } },
    git: {
      devBranchKeyPattern: '(^|/){KEY}(-|$)',
      ...git,
      // The integration branch is always protected, whatever the list says.
      protectedBranches: uniq([...(git.protectedBranches ?? ['main', 'master']), git.integrationBranch].filter(Boolean)),
    },
    stack: { healthTimeoutSec: 180, shaCheck: {}, ...stack, health: stack.health ?? [qa.baseUrl].filter(Boolean) },
    qa: {
      apiTestDir: qa.testDir,
      env: {},
      installCommand: DEFAULT_INSTALL,
      conventionsDocs: [],
      capabilities: [],
      knownDrift: [],
      // Every Nth run probes the known-drift tests once after the report (0 = never).
      driftProbeEvery: 5,
      ...qa,
      // The Playwright config is always protected (guard H4), whatever the list says.
      protectedFiles: uniq([...(qa.protectedFiles ?? []), qa.playwrightConfig].filter(Boolean)),
    },
    suites: c.suites ?? {},
    routes: c.routes ?? {},
    criticalAreas: c.criticalAreas ?? {},
    limits: { ...DEFAULT_LIMITS, ...(c.limits ?? {}) },
  };
}

// The change types qa-intake may return; a `routes` key outside them is never used.
function changeTypes() {
  const schema = JSON.parse(readFileSync(new URL('../../schemas/qa-intake.schema.json', import.meta.url), 'utf8'));
  return schema.properties.changeType.enum;
}

const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const isPlaceholder = (v) => typeof v === 'string' && /<[^>]*>/.test(v);

// problems: the run can't work until they're fixed. warnings: it works, but something looks off.
// With projectDir, also checks that the configured files exist in that checkout.
export function configProblems(raw, projectDir = null) {
  const config = withDefaults(raw);
  const problems = [];
  const warnings = [];

  const required = {
    'jira.projectKey': 'the Jira project key, e.g. "PROJ"',
    'jira.cloudId': 'the Atlassian site id (getAccessibleAtlassianResources)',
    'jira.statuses.ready': 'the Jira status of a ticket waiting for QA',
    'jira.statuses.inQa': 'the Jira status while QA works on it',
    'jira.statuses.review': 'the Jira status when QA is done and a person decides',
    'git.integrationBranch': 'the branch dev work is merged to before QA',
    'stack.composeFile': 'the Docker Compose file that starts the app for QA',
    'stack.project': 'a Docker Compose project name for the QA stack',
    'qa.testDir': 'the Playwright test folder',
    'qa.playwrightConfig': 'the Playwright config file',
    'qa.baseUrl': 'the app URL the QA stack serves',
  };
  for (const [key, what] of Object.entries(required)) {
    const v = get(raw, key);
    if (typeof v !== 'string' || !v.trim()) problems.push(`${key} is missing: ${what}`);
    else if (isPlaceholder(v)) problems.push(`${key} is still a placeholder (${v})`);
  }

  const ids = get(raw, 'jira.allowedTransitionIds');
  if (!Array.isArray(ids) || !ids.length) {
    problems.push('jira.allowedTransitionIds is missing: the ids of the Jira transitions → In QA and → QA Review');
  } else if (!ids.every((id) => /^\d+$/.test(String(id)))) {
    problems.push(`jira.allowedTransitionIds must be Jira transition ids (numbers as strings), got ${JSON.stringify(ids)}`);
  }
  if (typeof raw?.jira?.projectKey === 'string' && !isPlaceholder(raw.jira.projectKey) && !/^[A-Z][A-Z0-9]+$/.test(raw.jira.projectKey)) {
    problems.push(`jira.projectKey "${raw.jira.projectKey}" is not a Jira project key (capital letters and digits)`);
  }
  if (typeof raw?.stack?.project === 'string' && !isPlaceholder(raw.stack.project) && !/^[a-z0-9][a-z0-9_-]*$/.test(raw.stack.project)) {
    problems.push(`stack.project "${raw.stack.project}" must be lowercase letters, digits, "-" or "_" (a Docker Compose project name)`);
  }
  for (const key of ['qa.baseUrl', 'qa.apiUrl']) {
    const v = get(raw, key);
    if (typeof v === 'string' && !isPlaceholder(v) && !/^https?:\/\//.test(v)) problems.push(`${key} must be an http(s) URL, got "${v}"`);
  }

  // Unused keys: harmless, but they look like settings that do something.
  for (const key of Object.keys(raw ?? {})) {
    if (!(key in KNOWN)) warnings.push(`"${key}" is not used by the plugin; you can remove it`);
    else if (KNOWN[key] && raw[key] && typeof raw[key] === 'object') {
      for (const sub of Object.keys(raw[key])) if (!KNOWN[key].includes(sub)) warnings.push(`"${key}.${sub}" is not used by the plugin; you can remove it`);
    }
  }
  const statuses = raw?.jira?.statuses ?? {};
  for (const s of Object.keys(statuses)) {
    if (!['ready', 'inQa', 'review'].includes(s)) warnings.push(`"jira.statuses.${s}" is not used by the plugin; you can remove it`);
  }

  // Routing: every route must name known suites, and only change types intake can return are used.
  const types = changeTypes();
  for (const [type, names] of Object.entries(config.routes)) {
    if (!types.includes(type)) warnings.push(`routes.${type} is never used: qa-intake picks one of ${types.join(', ')}`);
    for (const n of Array.isArray(names) ? names : []) if (!config.suites[n]) warnings.push(`routes.${type} names the suite "${n}", which suites doesn't define`);
  }
  if (Object.keys(config.routes).length && !Object.keys(config.suites).length) warnings.push('routes is set but suites is empty, so routes does nothing');

  if (projectDir) {
    const exists = (rel) => existsSync(path.join(projectDir, rel));
    const mustExist = { 'qa.testDir': config.qa.testDir,'qa.playwrightConfig': config.qa.playwrightConfig, 'stack.composeFile': config.stack.composeFile };
    for (const [key, rel] of Object.entries(mustExist)) {
      if (typeof rel === 'string' && rel && !isPlaceholder(rel) && !exists(rel)) problems.push(`${key}: ${rel} doesn't exist in ${projectDir}`);
    }
    for (const f of config.qa.conventionsDocs) if (!exists(f)) warnings.push(`qa.conventionsDocs: ${f} doesn't exist`);
    for (const [name, files] of Object.entries(config.suites)) {
      for (const f of Array.isArray(files) ? files : []) if (!exists(f)) warnings.push(`suites.${name}: ${f} doesn't exist`);
    }
    // The runner hands the app URL to Playwright as BASE_URL (and API_URL); a config that ignores
    // them tests whatever URL it has hardcoded.
    const pw = config.qa.playwrightConfig;
    if (typeof pw === 'string' && exists(pw) && !readFileSync(path.join(projectDir, pw), 'utf8').includes('BASE_URL')) {
      warnings.push(`${pw} doesn't read process.env.BASE_URL, so tests may not run against qa.baseUrl (e.g. baseURL: process.env.BASE_URL ?? '…')`);
    }
  }
  return { problems, warnings };
}
