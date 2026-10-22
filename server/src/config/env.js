import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});

if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI is required. Run npm run setup from the project root.');
}

const port = Number(process.env.PORT || 5000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '127.0.0.1',
  port,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://127.0.0.1:5173',
  mongodbUri: process.env.MONGODB_URI,
};
