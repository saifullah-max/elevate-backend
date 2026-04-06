import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';
import dns from 'dns';

dotenv.config();

/* FIX: Force DNS resolver for MongoDB Atlas */
dns.setDefaultResultOrder("ipv4first");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

class MongoDBConnection {
  private static instance: MongoDBConnection;
  private isConnected: boolean = false;

  private constructor() { }

  static getInstance(): MongoDBConnection {
    if (!MongoDBConnection.instance) {
      MongoDBConnection.instance = new MongoDBConnection();
    }
    return MongoDBConnection.instance;
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      console.log('[MONGODB] Already connected');
      return;
    }

    const mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
      console.error('[MONGODB] ERROR: MONGODB_URI environment variable is not configured.');
      logger('[MONGODB] Warning: MONGODB_URI not configured.');
      return;
    }

    console.log('[MONGODB] Attempting to connect to MongoDB...');
    console.log('[MONGODB] URI prefix:', mongoUri.substring(0, 20) + '...');

    try {
      await mongoose.connect(mongoUri, {
        dbName: process.env.MONGODB_DB_NAME || 'elevate_logs',
      });

      this.isConnected = true;
      console.log('[MONGODB] ✅ Connected successfully');
      console.log('[MONGODB] Database:', process.env.MONGODB_DB_NAME || 'elevate_logs');
      logger('[MONGODB] Connected successfully');

      mongoose.connection.on('error', (error: Error) => {
        console.error(`[MONGODB] Connection error:`, error);
        logger(`[MONGODB] Connection error: ${error}`);
        this.isConnected = false;
      });

      mongoose.connection.on('disconnected', () => {
        console.warn('[MONGODB] Disconnected');
        logger('[MONGODB] Disconnected');
        this.isConnected = false;
      });

    } catch (error) {
      console.error(`[MONGODB] ❌ Failed to connect:`, error);
      logger(`[MONGODB] Failed to connect: ${error}`);
      this.isConnected = false;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;

    await mongoose.connection.close();
    this.isConnected = false;
    logger('[MONGODB] Disconnected');
  }

  getConnection() {
    return mongoose.connection;
  }

  isReady(): boolean {
    return this.isConnected;
  }
}

export const mongoDb = MongoDBConnection.getInstance();