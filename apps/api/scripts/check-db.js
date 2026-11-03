import { connectDatabase, disconnectDatabase } from '../src/config/database.js';

try {
  const connection = await connectDatabase();
  await connection.db.command({ ping: 1 });
  const collections = await connection.db.listCollections({}, { nameOnly: true }).toArray();
  console.log(`MongoDB ping successful. Database: ${connection.name}. Collections: ${collections.length}.`);
  console.log('No application schemas or collections are created by this check.');
} catch (error) {
  console.error(`MongoDB check failed (${error.name}). Check Docker and MONGODB_URI.`);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
