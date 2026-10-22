import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const envPath = new URL('../.env', import.meta.url);
const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const contents = template.replaceAll('replace-with-local-password', randomBytes(24).toString('hex'));

try {
  await writeFile(envPath, contents, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with local development credentials.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .env preserved.');
}
