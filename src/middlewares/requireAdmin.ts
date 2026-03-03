import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  logger(`[requireAdmin] Checking... req.user: ${JSON.stringify(req.user)}`);
  
  if (!req.user) {
    logger(`[requireAdmin] FAIL - No req.user attached`);
    return res.status(401).json({
      success: false,
      message: 'Authentication required',
    });
  }

  // Check if user has admin role
  const userRoles = (req.user as any).role || [];
  logger(`[requireAdmin] User roles: ${JSON.stringify(userRoles)}`);
  
  const isAdmin = Array.isArray(userRoles) 
    ? userRoles.includes('ADMIN') 
    : userRoles === 'ADMIN';

  logger(`[requireAdmin] Is admin: ${isAdmin}`);

  if (!isAdmin) {
    logger(`[requireAdmin] FAIL - User is not admin`);
    return res.status(403).json({
      success: false,
      message: 'Admin access required',
    });
  }

  logger(`[requireAdmin] PASS - Admin verified`);
  next();
}
