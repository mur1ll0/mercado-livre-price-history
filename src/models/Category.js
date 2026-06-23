import mongoose from 'mongoose';

const CategorySchema = new mongoose.Schema({
  _id: { type: String, required: true }, // Full path, e.g., "Celulares e Telefones > Acessórios para Celulares"
  name: { type: String, required: true }, // Leaf node name, e.g., "Acessórios para Celulares"
  parent: { type: String, default: null }, // Parent path, e.g., "Celulares e Telefones"
  level: { type: Number, default: 0 }, // Hierarchy depth (0-indexed)
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.Category || mongoose.model('Category', CategorySchema);
