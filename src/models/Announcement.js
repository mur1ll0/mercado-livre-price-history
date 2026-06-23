import mongoose from 'mongoose';

const AnnouncementSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // E.g. MLB54106888 or MLBU3468893823
  productId: { type: String, required: true, ref: 'UnifiedProduct', index: true },
  url: { type: String, required: true },
  title: { type: String, default: 'Carregando dados...' },
  price: { type: Number, default: null },
  originalPrice: { type: Number, default: null },
  installmentsText: { type: String, default: '' },
  interestFree: { type: Boolean, default: false },
  shippingCost: { type: Number, default: null }, // 0 for free
  deliveryTime: { type: String, default: '' },
  isFull: { type: Boolean, default: false },
  isFreeShipping: { type: Boolean, default: false },
  isUnavailable: { type: Boolean, default: false }, // Paused, out of stock, or deleted
  scrapedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.Announcement || mongoose.model('Announcement', AnnouncementSchema);
