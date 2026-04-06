import { Request, Response } from 'express';
import { loggingService } from '../services/logging.service';

/**
 * Get request logs with pagination and filters
 */
export async function getRequestLogsHandler(req: Request, res: Response) {
  try {
    const {
      page = '1',
      limit = '50',
      month,
      method,
      userId,
      startDate,
      endDate,
    } = req.query;

    const result = await loggingService.getRequestLogs({
      page: parseInt(page as string),
      limit: parseInt(limit as string),
      month: month as string,
      method: method as string,
      userId: userId as string,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('[ADMIN-LOGS] Error fetching request logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch request logs',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get payment logs with pagination and filters
 */
export async function getPaymentLogsHandler(req: Request, res: Response) {
  try {
    const {
      page = '1',
      limit = '50',
      month,
      status,
      userId,
      startDate,
      endDate,
    } = req.query;

    const result = await loggingService.getPaymentLogs({
      page: parseInt(page as string),
      limit: parseInt(limit as string),
      month: month as string,
      status: status as string,
      userId: userId as string,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('[ADMIN-LOGS] Error fetching payment logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch payment logs',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get multi-image logs with pagination and filters
 */
export async function getMultiImageLogsHandler(req: Request, res: Response) {
  try {
    const {
      page = '1',
      limit = '50',
      month,
      status,
      userId,
      startDate,
      endDate,
    } = req.query;

    const result = await loggingService.getMultiImageLogs({
      page: parseInt(page as string),
      limit: parseInt(limit as string),
      month: month as string,
      status: status as string,
      userId: userId as string,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('[ADMIN-LOGS] Error fetching multi-image logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch multi-image logs',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get available months for log collections
 */
export async function getAvailableMonthsHandler(req: Request, res: Response) {
  try {
    const months = await loggingService.getAvailableMonths();
    
    return res.status(200).json({
      success: true,
      data: { months },
    });
  } catch (error) {
    console.error('[ADMIN-LOGS] Error fetching available months:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch available months',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get aggregated log statistics
 */
export async function getLogStatsHandler(req: Request, res: Response) {
  try {
    const { month } = req.query;
    
    // For now, return basic counts - can be enhanced later with aggregations
    const [requests, payments, multiImage] = await Promise.all([
      loggingService.getRequestLogs({
        page: 1,
        limit: 1,
        month: month as string,
      }),
      loggingService.getPaymentLogs({
        page: 1,
        limit: 1,
        month: month as string,
      }),
      loggingService.getMultiImageLogs({
        page: 1,
        limit: 1,
        month: month as string,
      }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        month: month || 'current',
        totalRequests: requests.total,
        totalPayments: payments.total,
        totalMultiImageRuns: multiImage.total,
      },
    });
  } catch (error) {
    console.error('[ADMIN-LOGS] Error fetching log stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch log statistics',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
