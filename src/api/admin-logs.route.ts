import { Router } from 'express';
import passport from 'passport';
import { 
  getRequestLogsHandler, 
  getPaymentLogsHandler, 
  getMultiImageLogsHandler,
  getAvailableMonthsHandler,
  getLogStatsHandler 
} from '../controllers/admin-logs.controller';
import { requireAdmin } from '../middlewares/requireAdmin';
import { logger } from '../utils/logger';

const router = Router();

// Protect all admin log routes with Passport JWT
router.use((req, res, next) => {
  logger(`[admin-logs] Incoming request: ${req.method} ${req.path}`);
  next();
});

router.use(passport.authenticate('jwt', { session: false, failureMessage: true }), (err: any, req: any, res: any, next: any) => {
  if (err) {
    logger(`[admin-logs] Passport error: ${err.message}`);
    const errorResponse = {
      success: false,
      timestamp: new Date().toISOString(),
      message: 'Authentication failed',
      error: err.message,
      details: {
        authHeader: req.headers.authorization ? 'Present' : 'Missing',
        method: req.method,
        path: req.path,
        userObject: req.user ? 'Exists' : 'Null/Undefined',
      }
    };
    console.log('[admin-logs] Error response:', errorResponse);
    return res.status(401).json(errorResponse);
  }
  next();
});

router.use(requireAdmin);

// Get available months for logs
router.get('/months', getAvailableMonthsHandler);

// Get log statistics
router.get('/stats', getLogStatsHandler);

// Get request logs
router.get('/requests', getRequestLogsHandler);

// Get payment logs
router.get('/payments', getPaymentLogsHandler);

// Get multi-image logs
router.get('/multi-image', getMultiImageLogsHandler);

export default router;
