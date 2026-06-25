import mongoose from 'mongoose';

/**
 * Sub-schema for individual offer data within a catalog announcement.
 * Used for BEST_PRICE and BEST_INSTALLMENTS offer types.
 */
const OfferDataSchema = new mongoose.Schema({
  price: { type: Number, default: null },
  originalPrice: { type: Number, default: null },
  discountPercent: { type: Number, default: 0 },
  installmentsText: { type: String, default: '' },
  installmentsTotal: { type: Number, default: null },
  interestFree: { type: Boolean, default: false },
  shippingCost: { type: Number, default: null },
  deliveryDate: { type: Date, default: null },
  isFull: { type: Boolean, default: false },
  isFreeShipping: { type: Boolean, default: false },
  seller: { type: String, default: null }
}, { _id: false });

const AnnouncementSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // MLB/MLBU ID only, no suffixes
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  productId: { type: String, required: true, ref: 'UnifiedProduct', index: true },
  url: { type: String, required: true },
  title: { type: String, default: 'Carregando dados...' },
  type: { type: String, enum: ['catalog', 'normal'], default: 'normal' },

  // Fields for NORMAL type announcements:
  price: { type: Number, default: null },
  originalPrice: { type: Number, default: null },
  discountPercent: { type: Number, default: 0 },
  installmentsText: { type: String, default: '' },
  installmentsTotal: { type: Number, default: null },
  interestFree: { type: Boolean, default: false },
  shippingCost: { type: Number, default: null },
  deliveryDate: { type: Date, default: null },
  isFull: { type: Boolean, default: false },
  isFreeShipping: { type: Boolean, default: false },
  seller: { type: String, default: null },

  // Fields for CATALOG type announcements:
  offers: {
    BEST_PRICE: { type: OfferDataSchema, default: null },
    BEST_INSTALLMENTS: { type: OfferDataSchema, default: null }
  },

  // Product-level fields (extracted from any page type):
  rating: { type: Number, default: null },
  reviewsCount: { type: Number, default: 0 },
  aiSummary: { type: String, default: '' },
  categories: [{ type: String, ref: 'Category' }], // Category._id paths for this announcement
  specifications: [{ key: String, value: String }], // Key/value pairs from product specs table

  isUnavailable: { type: Boolean, default: false },
  scrapeStatus: { type: String, enum: ['pending', 'scraping', 'done', 'error'], default: null },
  scrapedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.Announcement || mongoose.model('Announcement', AnnouncementSchema);
