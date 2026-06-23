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
    
    app.listen(PORT, () => {
      console.log(`\n==================================================`);
      console.log(`  Server is running in ${process.env.NODE_ENV || 'development'} mode`);
      console.log(`  Local Access: http://localhost:${PORT}`);
      console.log(`==================================================\n`);
    });
  } catch (err) {
    console.error('[server] Failed to start server:', err.message);
    process.exit(1);
  }
}

startServer();
