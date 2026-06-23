import { app } from '../src/app.js';
import { connectDB } from '../src/db.js';

let isDbConnected = false;

export default async function handler(req, res) {
  try {
    if (!isDbConnected) {
      await connectDB();
      isDbConnected = true;
    }
    return app(req, res);
  } catch (error) {
    console.error('[serverless] Handler execution error:', error);
    return res.status(500).json({
      error: {
        name: 'ServerlessHandlerError',
        message: error?.message || 'Internal serverless API invocation failure'
      }
    });
  }
}
