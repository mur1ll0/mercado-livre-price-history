import mongoose from 'mongoose';
import dns from 'dns';

dns.setDefaultResultOrder('ipv4first');
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (err) {
  console.warn('[db] Warning: Failed to configure custom DNS servers:', err.message);
}


export async function connectDB() {
  if (mongoose.connection.readyState >= 1) {
    return;
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/mercado-livre-price-history';

  console.log('[db] Connecting to MongoDB...');
  try {
    await mongoose.connect(uri, {
      bufferCommands: false,
    });
    console.log('[db] Connected to MongoDB successfully.');
  } catch (err) {
    console.error('[db] Error connecting to MongoDB:', err.message);
    throw err;
  }
}
