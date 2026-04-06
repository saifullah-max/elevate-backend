import mongoose, { Schema, Document } from 'mongoose';

export interface IRequestLog extends Document {
  timestamp: Date;
  method: string;
  path: string;
  statusCode?: number;
  userId?: string;
  userEmail?: string;
  userRole?: string;
  ip: string;
  userAgent?: string;
  requestBody?: any;
  responseTime?: number;
  error?: string;
  metadata?: Record<string, any>;
}

const RequestLogSchema: Schema = new Schema({
  timestamp: { type: Date, default: Date.now, index: true },
  method: { type: String, required: true, index: true },
  path: { type: String, required: true, index: true },
  statusCode: { type: Number },
  userId: { type: String, index: true },
  userEmail: { type: String },
  userRole: { type: String },
  ip: { type: String, required: true },
  userAgent: { type: String },
  requestBody: { type: Schema.Types.Mixed },
  responseTime: { type: Number },
  error: { type: String },
  metadata: { type: Schema.Types.Mixed },
}, {
  timeseries: {
    timeField: 'timestamp',
    metaField: 'metadata',
    granularity: 'hours'
  }
});

// Helper to get collection name for current month
export function getRequestLogCollectionName(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `request_logs_${year}_${month}`;
}

// Dynamic model getter
export function getRequestLogModel(date: Date = new Date()) {
  const collectionName = getRequestLogCollectionName(date);
  
  // Check if model already exists to avoid OverwriteModelError
  if (mongoose.models[collectionName]) {
    return mongoose.models[collectionName];
  }
  
  return mongoose.model<IRequestLog>(collectionName, RequestLogSchema, collectionName);
}
