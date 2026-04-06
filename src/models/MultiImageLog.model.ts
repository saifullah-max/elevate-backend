import mongoose, { Schema, Document } from 'mongoose';

export interface IMultiImageLog extends Document {
  timestamp: Date;
  runId: string;
  userId: string;
  userEmail?: string;
  teamId?: string;
  totalImages: number;
  expectedVariants: number;
  completedVariants: number;
  failedVariants: number;
  roomType: string;
  stagingStyle: string;
  prompt?: string;
  creditsUsed: number;
  estimatedSeconds: number;
  elapsedSeconds: number;
  queueConcurrency: number;
  rateLimit: string;  // e.g., "18/min"
  status: 'completed' | 'partial' | 'failed';
  images: Array<{
    originalFile: string;
    totalVariations: number;
    completed: number;
    failed: number;
  }>;
  quotaExhausted: boolean;
  metadata?: Record<string, any>;
}

const MultiImageLogSchema: Schema = new Schema({
  timestamp: { type: Date, default: Date.now, index: true },
  runId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  userEmail: { type: String },
  teamId: { type: String, index: true },
  totalImages: { type: Number, required: true },
  expectedVariants: { type: Number, required: true },
  completedVariants: { type: Number, required: true },
  failedVariants: { type: Number, required: true },
  roomType: { type: String, required: true },
  stagingStyle: { type: String, required: true },
  prompt: { type: String },
  creditsUsed: { type: Number, required: true },
  estimatedSeconds: { type: Number },
  elapsedSeconds: { type: Number, required: true },
  queueConcurrency: { type: Number },
  rateLimit: { type: String },
  status: { type: String, enum: ['completed', 'partial', 'failed'], required: true, index: true },
  images: [{
    originalFile: String,
    totalVariations: Number,
    completed: Number,
    failed: Number,
  }],
  quotaExhausted: { type: Boolean, default: false },
  metadata: { type: Schema.Types.Mixed },
});

export function getMultiImageLogCollectionName(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `multi_image_logs_${year}_${month}`;
}

export function getMultiImageLogModel(date: Date = new Date()) {
  const collectionName = getMultiImageLogCollectionName(date);
  
  if (mongoose.models[collectionName]) {
    return mongoose.models[collectionName];
  }
  
  return mongoose.model<IMultiImageLog>(collectionName, MultiImageLogSchema, collectionName);
}
