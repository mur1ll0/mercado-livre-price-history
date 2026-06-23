import mongoose from 'mongoose';

const UserProductSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: String, ref: 'UnifiedProduct', required: true },
  createdAt: { type: Date, default: Date.now }
});

// Ensure a user can track a product only once
UserProductSchema.index({ userId: 1, productId: 1 }, { unique: true });

export default mongoose.models.UserProduct || mongoose.model('UserProduct', UserProductSchema);
