import mongoose from 'mongoose';

const OfferPriceSchema = new mongoose.Schema({
  price: { type: Number, default: null },
  installmentsTotal: { type: Number, default: null }
}, { _id: false });

const PriceRecordSchema = new mongoose.Schema({
  productId: { type: String, required: true, ref: 'UnifiedProduct', index: true },
  announcementId: { type: String, required: true, ref: 'Announcement', index: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  price: { type: Number, default: null },
  installmentsTotal: { type: Number, default: null },
  // For catalog-type announcements, store both offers in one record
  offers: {
    BEST_PRICE: { type: OfferPriceSchema, default: null },
    BEST_INSTALLMENTS: { type: OfferPriceSchema, default: null }
  },
  createdAt: { type: Date, default: Date.now }
});

PriceRecordSchema.index({ announcementId: 1, date: 1 }, { unique: true });

export default mongoose.models.PriceRecord || mongoose.model('PriceRecord', PriceRecordSchema);
