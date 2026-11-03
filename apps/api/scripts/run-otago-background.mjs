import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
for (const script of ['import-otago.mjs', 'enrich-otago.mjs']) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`apps/api/scripts/${script}`], {
      cwd: root, stdio: 'inherit', windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (result !== 0) { process.exitCode = result || 1; break; }
}
