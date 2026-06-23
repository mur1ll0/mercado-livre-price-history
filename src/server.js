import dotenv from 'dotenv';
import { app } from './app.js';
import { connectDB } from './db.js';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 3000;

// Start Server
async function startServer() {
  try {
    // Establish database connection
    await connectDB();
    
    // Start listening
    app.listen(PORT, () => {
      console.log(`[server] Server is running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
    });
  } catch (err) {
    console.error('[server] Failed to start server:', err.message);
    process.exit(1);
  }
}

startServer();
