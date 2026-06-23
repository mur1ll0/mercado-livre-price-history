import mongoose from 'mongoose';

const PriceRecordSchema = new mongoose.Schema({
  announcementId: { type: String, required: true, ref: 'Announcement', index: true },
  date: { type: String, required: true }, // Format YYYY-MM-DD
  price: { type: Number, required: true },
  originalPrice: { type: Number, default: null },
  installmentsTotal: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now }
});

// Ensure unique price log per day per announcement
PriceRecordSchema.index({ announcementId: 1, date: 1 }, { unique: true });

export default mongoose.models.PriceRecord || mongoose.model('PriceRecord', PriceRecordSchema);
