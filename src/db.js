import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/mercado-livre-price-history';

export async function connectDB() {
  if (mongoose.connection.readyState >= 1) {
    return;
  }

  console.log('[db] Connecting to MongoDB...');
  try {
    await mongoose.connect(MONGODB_URI, {
      bufferCommands: false,
    });
    console.log('[db] Connected to MongoDB successfully.');
  } catch (err) {
    console.error('[db] Error connecting to MongoDB:', err.message);
    throw err;
  }
}
