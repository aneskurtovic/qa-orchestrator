// Checks a project's .qa/config.json (docs/design.md §3): required keys, leftover placeholders,
// files that must exist, keys the plugin doesn't read. The setup skill runs it after writing the
// file; anyone can run it after editing one by hand.
//
//   check-config.mjs --project <dir>
//
// Prints { ok, problems, warnings }. Exit 3 = there are problems (the JSON lists them).
import path from 'node:path';
import { isMain, loadConfig, main, need, readJson } from './lib/common.mjs';
import { configProblems } from './lib/config.mjs';

export function checkConfig(project) {
  loadConfig(project); // a clear "run setup" error when the file is missing
  const { problems, warnings } = configProblems(readJson(path.join(project, '.qa', 'config.json')), project);
  return { ok: !problems.length, problems, warnings };
}

if (isMain(import.meta.url)) {
  main(async (args) => {
    need(args, 'project');
    const result = checkConfig(args.project);
    if (!result.ok) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(3);
    }
    return result;
  });
}
