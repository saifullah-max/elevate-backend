import mongoose, { Schema, Document } from 'mongoose';

export interface IPaymentLog extends Document {
  timestamp: Date;
  userId: string;
  userEmail?: string;
  teamId?: string;
  transactionId?: string;
  amount: number;
  currency: string;
  credits: number;
  paymentMethod: string;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  provider: string;
  providerResponse?: any;
  emailSent: boolean;
  emailSentAt?: Date;
  emailError?: string;
  metadata?: Record<string, any>;
}

const PaymentLogSchema: Schema = new Schema({
  timestamp: { type: Date, default: Date.now, index: true },
  userId: { type: String, required: true, index: true },
  userEmail: { type: String, index: true },
  teamId: { type: String, index: true },
  transactionId: { type: String, index: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  credits: { type: Number, required: true },
  paymentMethod: { type: String },
  status: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], required: true, index: true },
  provider: { type: String, required: true },
  providerResponse: { type: Schema.Types.Mixed },
  emailSent: { type: Boolean, default: false, index: true },
  emailSentAt: { type: Date },
  emailError: { type: String },
  metadata: { type: Schema.Types.Mixed },
});

export function getPaymentLogCollectionName(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `payment_logs_${year}_${month}`;
}

export function getPaymentLogModel(date: Date = new Date()) {
  const collectionName = getPaymentLogCollectionName(date);
  
  if (mongoose.models[collectionName]) {
    return mongoose.models[collectionName];
  }
  
  return mongoose.model<IPaymentLog>(collectionName, PaymentLogSchema, collectionName);
}
