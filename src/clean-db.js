import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from './db.js';

dotenv.config();

async function cleanDB() {
  await connectDB();
  const db = mongoose.connection.db;

  const collections = await db.listCollections().toArray();
  const names = collections.map(c => c.name);

  console.log(`Found ${names.length} collections: ${names.join(', ')}`);
  console.log('Dropping all collections...');

  for (const name of names) {
    await db.dropCollection(name);
    console.log(`  Dropped: ${name}`);
  }

  console.log('Database cleaned.');
  await mongoose.disconnect();
  process.exit(0);
}

cleanDB().catch(err => {
  console.error('Error:', err.message);
  mongoose.disconnect();
  process.exit(1);
});
