import { Request } from 'express';
import { getRequestLogModel } from '../models/RequestLog.model';
import { getPaymentLogModel, IPaymentLog } from '../models/PaymentLog.model';
import { getMultiImageLogModel, IMultiImageLog } from '../models/MultiImageLog.model';
import { mongoDb } from '../config/mongodb.config';
import { logger } from '../utils/logger';

class LoggingService {
  private isEnabled(): boolean {
    return mongoDb.isReady();
  }

  /**
   * Log HTTP request
   */
  async logRequest(data: {
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
  }): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const RequestLog = getRequestLogModel();
      await RequestLog.create({
        timestamp: new Date(),
        ...data,
      });
    } catch (error) {
      logger(`[LOGGING] Failed to log request: ${error}`);
    }
  }

  /**
   * Log payment transaction
   */
  async logPayment(data: Partial<IPaymentLog>): Promise<void> {
    console.log('[PAYMENT-LOG] Attempting to log payment to MongoDB...');
    
    if (!this.isEnabled()) {
      console.log('[PAYMENT-LOG] MongoDB is not ready. Skipping log.');
      return;
    }

    try {
      const PaymentLog = getPaymentLogModel();
      const logEntry = {
        timestamp: new Date(),
        ...data,
      };
      console.log('[PAYMENT-LOG] Creating payment log entry:', JSON.stringify({
        transactionId: data.transactionId,
        userId: data.userId,
        userEmail: data.userEmail || 'N/A',
        amount: data.amount,
        status: data.status,
        credits: data.credits
      }));
      
      const result = await PaymentLog.create(logEntry);
      console.log('[PAYMENT-LOG] ✅ Successfully logged payment to MongoDB, ID:', result._id);
    } catch (error: any) {
      console.error('[PAYMENT-LOG] ❌ Failed to log payment:', error);
      console.error('[PAYMENT-LOG] Error details:', {
        name: error.name,
        message: error.message,
        errors: error.errors,
        stack: error.stack
      });
      logger(`[LOGGING] Failed to log payment: ${error}`);
    }
  }

  /**
   * Log multi-image generation run
   */
  async logMultiImageRun(data: Partial<IMultiImageLog>): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const MultiImageLog = getMultiImageLogModel();
      await MultiImageLog.create({
        timestamp: new Date(),
        ...data,
      });
    } catch (error) {
      logger(`[LOGGING] Failed to log multi-image run: ${error}`);
    }
  }

  /**
   * Get request logs with pagination
   */
  async getRequestLogs(options: {
    page?: number;
    limit?: number;
    method?: string;
    userId?: string;
    startDate?: Date;
    endDate?: Date;
    month?: string; // Format: YYYY-MM
  }) {
    if (!this.isEnabled()) {
      return { logs: [], total: 0, page: 1, pages: 1 };
    }

    const page = options.page || 1;
    const limit = Math.min(options.limit || 50, 100);
    const skip = (page - 1) * limit;

    try {
      // Determine which collection to query
      const date = options.month ? new Date(options.month) : new Date();
      const RequestLog = getRequestLogModel(date);

      const filter: any = {};
      
      if (options.method) filter.method = options.method;
      if (options.userId) filter.userId = options.userId;
      if (options.startDate || options.endDate) {
        filter.timestamp = {};
        if (options.startDate) filter.timestamp.$gte = options.startDate;
        if (options.endDate) filter.timestamp.$lte = options.endDate;
      }

      const [logs, total] = await Promise.all([
        RequestLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
        RequestLog.countDocuments(filter),
      ]);

      return {
        logs,
        total,
        page,
        pages: Math.ceil(total / limit),
        limit,
      };
    } catch (error) {
      logger(`[LOGGING] Failed to get request logs: ${error}`);
      return { logs: [], total: 0, page: 1, pages: 1 };
    }
  }

  /**
   * Get payment logs with pagination
   */
  async getPaymentLogs(options: {
    page?: number;
    limit?: number;
    userId?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
    month?: string;
  }) {
    if (!this.isEnabled()) {
      return { logs: [], total: 0, page: 1, pages: 1 };
    }

    const page = options.page || 1;
    const limit = Math.min(options.limit || 50, 100);
    const skip = (page - 1) * limit;

    try {
      const date = options.month ? new Date(options.month) : new Date();
      const PaymentLog = getPaymentLogModel(date);

      const filter: any = {};
      
      if (options.userId) filter.userId = options.userId;
      if (options.status) filter.status = options.status;
      if (options.startDate || options.endDate) {
        filter.timestamp = {};
        if (options.startDate) filter.timestamp.$gte = options.startDate;
        if (options.endDate) filter.timestamp.$lte = options.endDate;
      }

      const [logs, total] = await Promise.all([
        PaymentLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
        PaymentLog.countDocuments(filter),
      ]);

      return {
        logs,
        total,
        page,
        pages: Math.ceil(total / limit),
        limit,
      };
    } catch (error) {
      logger(`[LOGGING] Failed to get payment logs: ${error}`);
      return { logs: [], total: 0, page: 1, pages: 1 };
    }
  }

  /**
   * Get multi-image logs with pagination
   */
  async getMultiImageLogs(options: {
    page?: number;
    limit?: number;
    userId?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
    month?: string;
  }) {
    if (!this.isEnabled()) {
      return { logs: [], total: 0, page: 1, pages: 1 };
    }

    const page = options.page || 1;
    const limit = Math.min(options.limit || 50, 100);
    const skip = (page - 1) * limit;

    try {
      const date = options.month ? new Date(options.month) : new Date();
      const MultiImageLog = getMultiImageLogModel(date);

      const filter: any = {};
      
      if (options.userId) filter.userId = options.userId;
      if (options.status) filter.status = options.status;
      if (options.startDate || options.endDate) {
        filter.timestamp = {};
        if (options.startDate) filter.timestamp.$gte = options.startDate;
        if (options.endDate) filter.timestamp.$lte = options.endDate;
      }

      const [logs, total] = await Promise.all([
        MultiImageLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
        MultiImageLog.countDocuments(filter),
      ]);

      return {
        logs,
        total,
        page,
        pages: Math.ceil(total / limit),
        limit,
      };
    } catch (error) {
      logger(`[LOGGING] Failed to get multi-image logs: ${error}`);
      return { logs: [], total: 0, page: 1, pages: 1 };
    }
  }

  /**
   * Get available log months
   */
  async getAvailableMonths(): Promise<string[]> {
    if (!this.isEnabled()) return [];

    try {
      const collections = await mongoDb.getConnection().db?.listCollections().toArray();
      if (!collections) return [];

      const months = new Set<string>();
      
      collections.forEach((col: { name: string }) => {
        const match = col.name.match(/_(\d{4})_(\d{2})$/);
        if (match) {
          months.add(`${match[1]}-${match[2]}`);
        }
      });

      return Array.from(months).sort().reverse();
    } catch (error) {
      logger(`[LOGGING] Failed to get available months: ${error}`);
      return [];
    }
  }
}

export const loggingService = new LoggingService();
