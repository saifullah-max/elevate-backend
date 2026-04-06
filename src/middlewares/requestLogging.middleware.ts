import { Request, Response, NextFunction } from 'express';
import { loggingService } from '../services/logging.service';

// Sensitive paths that should be logged
const SENSITIVE_GET_PATHS = [
  '/api/auth/me',
  '/api/payment/transactions',
  '/api/teams',
  '/api/admin',
];

// Paths to exclude from logging (health checks, static assets, etc.)
const EXCLUDED_PATHS = [
  '/api/health',
  '/api/ping',
  '/favicon.ico',
];

// Fields to redact from request bodies
const REDACTED_FIELDS = ['password', 'cardNumber', 'cvv', 'apiKey', 'token'];

function shouldLogRequest(req: Request): boolean {
  const path = req.path;
  
  // Exclude specific paths
  if (EXCLUDED_PATHS.some(excluded => path.startsWith(excluded))) {
    return false;
  }

  // Always log POST, PATCH, DELETE
  if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
    return true;
  }

  // Log sensitive GET requests
  if (req.method === 'GET' && SENSITIVE_GET_PATHS.some(sensitive => path.startsWith(sensitive))) {
    return true;
  }

  return false;
}

function redactSensitiveData(data: any): any {
  if (!data || typeof data !== 'object') return data;

  const redacted = { ...data };

  REDACTED_FIELDS.forEach(field => {
    if (redacted[field]) {
      redacted[field] = '[REDACTED]';
    }
  });

  return redacted;
}

function getClientIp(req: Request): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    (req.headers['x-real-ip'] as string) ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

export function requestLoggingMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!shouldLogRequest(req)) {
    return next();
  }

  const startTime = Date.now();
  
  // Capture original end method
  const originalEnd = res.end;
  const originalJson = res.json;

  let logged = false;

  const logRequest = () => {
    if (logged) return;
    logged = true;

    const responseTime = Date.now() - startTime;
    const user = (req as any).user;

    loggingService.logRequest({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      userId: user?.id,
      userEmail: user?.email,
      userRole: user?.role?.[0],
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      requestBody: req.method !== 'GET' ? redactSensitiveData(req.body) : undefined,
      responseTime,
      error: res.statusCode >= 400 ? res.statusMessage : undefined,
      metadata: {
        query: req.query,
        params: req.params,
      },
    });
  };

  // Override response methods
  res.end = function(chunk?: any, encoding?: any, callback?: any) {
    logRequest();
    return originalEnd.call(this, chunk, encoding, callback);
  };

  res.json = function(body?: any) {
    logRequest();
    return originalJson.call(this, body);
  };

  // Handle unexpected errors
  res.on('finish', () => {
    logRequest();
  });

  next();
}
