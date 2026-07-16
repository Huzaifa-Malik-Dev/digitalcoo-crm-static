const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    cat: { type: String, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ cat: 1 });
productSchema.index({ active: 1 });

module.exports = mongoose.model('Product', productSchema);
