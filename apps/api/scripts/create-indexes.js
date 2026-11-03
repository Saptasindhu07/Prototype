import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { Researcher, Publication } from '../src/models/index.js';

try {
  await connectDatabase();
  for (const model of [Researcher, Publication]) {
    await model.createIndexes();
    console.log(`Indexes created for ${model.collection.name}.`);
  }
} catch (error) {
  console.error(`Index creation failed (${error.name}, code: ${error.code ?? 'unknown'}).`);
  console.error('Check the database connection, permissions, and duplicate external IDs.');
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
