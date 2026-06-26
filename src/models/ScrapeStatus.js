import mongoose from 'mongoose';

const ScrapeStatusSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  state: { type: String, enum: ['idle', 'needs_login', 'running', 'done', 'error'], default: 'idle' },
  message: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.models.ScrapeStatus || mongoose.model('ScrapeStatus', ScrapeStatusSchema);
