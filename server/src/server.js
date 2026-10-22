import app from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';

try {
  const database = await connectDatabase();
  console.log(`MongoDB connected: ${database.name}`);

  const server = app.listen(env.port, env.host, () => {
    console.log(`API listening at http://${env.host}:${env.port}`);
  });

  server.on('error', async (error) => {
    console.error(`API could not start (${error.code || error.name}).`);
    await disconnectDatabase();
    process.exitCode = 1;
  });

  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();

    server.close(async () => {
      try {
        await disconnectDatabase();
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error(`Database connection failed (${error.name}). Check MongoDB and MONGODB_URI.`);
  await disconnectDatabase();
  process.exitCode = 1;
}
