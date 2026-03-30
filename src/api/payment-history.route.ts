import { Router } from "express";
import PaymentHistoryController from "../controllers/payment-history.controller";
import { requireAuth } from "../middlewares/auth";

const router = Router();

/**
 * Payment History Routes
 * All routes require authentication
 */

// Get complete payment history
router.get("/history", requireAuth, PaymentHistoryController.getPaymentHistory);

// Get invoices list
router.get("/invoices", requireAuth, PaymentHistoryController.getInvoices);

// Get invoice preview/HTML
router.get(
    "/invoices/:subscriptionId/preview",
    requireAuth,
    PaymentHistoryController.getInvoicePreview
);

// Get payment summary/stats
router.get("/summary", requireAuth, PaymentHistoryController.getPaymentSummary);

export default router;
