import mongoose from 'mongoose';
import crypto from 'crypto';

const UnifiedProductSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomUUID() },
  name: { type: String, required: true },
  categories: [{ type: String, ref: 'Category' }], // Category._id references (full paths)
  image: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.UnifiedProduct || mongoose.model('UnifiedProduct', UnifiedProductSchema);
