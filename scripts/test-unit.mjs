import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const files = [];
for (const directory of ['apps/web/tests', 'apps/api/tests', 'packages/search/tests']) {
  for (const name of (await readdir(directory)).sort()) {
    if (/\.test\.(?:js|mjs)$/.test(name) && !name.endsWith('.mongo.test.js')) files.push(`${directory}/${name}`);
  }
}
const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
