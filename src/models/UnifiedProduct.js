import mongoose from 'mongoose';
import crypto from 'crypto';

const UnifiedProductSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  name: { type: String, required: true },
  category: { type: String, required: true },
  rating: { type: Number, default: null },
  reviewsCount: { type: Number, default: 0 },
  aiSummary: { type: String, default: '' },
  image: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.UnifiedProduct || mongoose.model('UnifiedProduct', UnifiedProductSchema);
