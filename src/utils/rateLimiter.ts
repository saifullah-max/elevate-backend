import { logger } from "./logger";

/**
 * Simple rate limiter using sliding window
 * Ensures we don't exceed a specific number of requests per time window
 */
export class RateLimiter {
  private requestTimestamps: number[] = [];
  private maxRequests: number;
  private windowMs: number;
  private minIntervalMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    // Calculate minimum interval between requests to evenly pace them
    this.minIntervalMs = Math.ceil(windowMs / maxRequests);
  }

  /**
   * Wait if necessary to respect rate limits
   * Returns the delay in milliseconds (0 if no delay needed)
   */
  async acquire(operationName: string = "operation"): Promise<number> {
    const now = Date.now();
    
    // Remove timestamps outside the current window
    this.requestTimestamps = this.requestTimestamps.filter(
      (timestamp) => now - timestamp < this.windowMs
    );

    // If we're at the limit, calculate when the oldest request will expire
    if (this.requestTimestamps.length >= this.maxRequests) {
      const oldestTimestamp = this.requestTimestamps[0];
      const waitTime = this.windowMs - (now - oldestTimestamp) + 100; // +100ms buffer
      
      logger(
        `[RATE_LIMIT] At limit (${this.requestTimestamps.length}/${this.maxRequests}), waiting ${Math.round(waitTime / 1000)}s`
      );
      
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      
      // Recursively call to re-check after waiting
      return waitTime + await this.acquire(operationName);
    }

    // Check minimum interval between consecutive requests for smooth pacing
    if (this.requestTimestamps.length > 0) {
      const lastRequestTime = this.requestTimestamps[this.requestTimestamps.length - 1];
      const timeSinceLastRequest = now - lastRequestTime;
      
      if (timeSinceLastRequest < this.minIntervalMs) {
        const paceDelay = this.minIntervalMs - timeSinceLastRequest;
        
        // Only log every 10th paced request to reduce noise
        if (this.requestTimestamps.length % 10 === 0) {
          logger(
            `[RATE_LIMIT] Pacing at ${this.requestTimestamps.length}/${this.maxRequests} requests`
          );
        }
        
        await new Promise((resolve) => setTimeout(resolve, paceDelay));
        return paceDelay + await this.acquire(operationName);
      }
    }

    // Record this request
    this.requestTimestamps.push(Date.now());
    
    return 0;
  }

  /**
   * Get current usage stats
   */
  getStats() {
    const now = Date.now();
    const activeRequests = this.requestTimestamps.filter(
      (timestamp) => now - timestamp < this.windowMs
    ).length;

    return {
      activeRequests,
      maxRequests: this.maxRequests,
      windowMs: this.windowMs,
      utilizationPercent: Math.round((activeRequests / this.maxRequests) * 100),
    };
  }

  /**
   * Reset the rate limiter (useful for testing or manual resets)
   */
  reset() {
    this.requestTimestamps = [];
  }
}
