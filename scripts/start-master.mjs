import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import concurrently from 'concurrently';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = 'work/ml/training-runs/bge-full-20261103T093751720940Z-bdc36df2';
const python = process.platform === 'win32'
  ? 'ml/.venv/Scripts/python.exe'
  : 'ml/.venv/bin/python';
const readJson = async (path) => JSON.parse((await readFile(resolve(root, path), 'utf8')).replace(/^\uFEFF/, ''));

try {
  const ready = await readJson(`${run}/ready-model.json`);
  const report = await readJson(`${run}/report.json`);
  if (ready.status !== 'ready-for-joint-connection') {
    throw new Error('The selected model is not verified and ready.');
  }
  if (!Number.isInteger(report.steps_completed) || report.steps_completed < 1) {
    throw new Error('The selected training report has no completed steps.');
  }
  await access(resolve(root, ready.bundle, 'manifest.json'));
  await access(resolve(root, python));

  const database = spawnSync(process.execPath, ['apps/api/scripts/check-db.js'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (database.error) throw database.error;
  if (database.status !== 0) throw new Error('Start MongoDB before running npm run master.');

  const node = `"${process.execPath}"`;
  const pythonCommand = `"${resolve(root, python)}"`;
  console.log(`Starting all four servers with model ${ready.model_version}. Press Ctrl+C to stop them.`);
  console.log('Frontend: http://127.0.0.1:5174 | Training tracker: http://127.0.0.1:8766');

  const { result } = concurrently([
    {
      name: 'api',
      command: `${node} apps/api/src/server.js`,
      env: {
        AI_RECOMMENDATIONS_ENABLED: 'true',
        AI_INFERENCE_URL: 'http://127.0.0.1:8100',
        CLIENT_ORIGIN: 'http://127.0.0.1:5174',
      },
    },
    {
      name: 'web',
      command: `${node} ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort`,
      cwd: resolve(root, 'apps/web'),
    },
    {
      name: 'ai',
      command: `${pythonCommand} -m uvicorn inference_api:app --app-dir ml --host 127.0.0.1 --port 8100`,
      env: { AI_MODEL_BUNDLE: resolve(root, ready.bundle), PYTHONUNBUFFERED: '1' },
    },
    {
      name: 'tracker',
      command: `${pythonCommand} ml/training_tracker.py --training-run ${run} --total-steps ${report.steps_completed} --port 8766`,
    },
  ], { cwd: root, prefix: 'name', killOthersOn: ['failure', 'success'] });

  await result.catch(() => { process.exitCode = 1; });
} catch (error) {
  console.error(`Cannot start app servers: ${error.message}`);
  process.exitCode = 1;
}
