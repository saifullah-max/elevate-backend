import { Request, Response } from "express";
import prisma from "../dbConnection";
import InvoiceService from "../services/invoice.service";

/**
 * Payment History Controller
 * Shows all transactions, subscriptions, and invoices for a user
 */
export class PaymentHistoryController {
    /**
     * GET /api/payments/history
     * Get complete payment history including subscriptions
     */
    static async getPaymentHistory(req: Request, res: Response) {
        try {
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ error: "Unauthorized" });
            }

            // Get all credit purchases (subscriptions)
            const subscriptions = await prisma.user_credit_purchase.findMany({
                where: { user_id: userId },
                include: { package: true },
                orderBy: { created_at: "desc" },
            });

            // Transform to transaction format
            const transactions = subscriptions.map((sub) => ({
                id: sub.id,
                type: "subscription",
                packageName: sub.package.name,
                credits: sub.amount,
                monthlyAmount: sub.price_usd,
                // Total amount charged including renewals
                totalAmount: sub.price_usd * (1 + sub.renewalCount),
                status: sub.status,
                autoRenewal: sub.autoRenewEnabled,
                renewalCount: sub.renewalCount,
                createdAt: sub.created_at,
                completedAt: sub.completed_at,
                nextRenewalDate: sub.nextRenewalDate,
                cancelledAt: sub.cancelledAt,
                cancellationReason: sub.cancellationReason,
                stripeInvoiceId: sub.stripe_invoice_id,
            }));

            return res.status(200).json({
                success: true,
                data: {
                    userId,
                    totalTransactions: transactions.length,
                    // Total spent includes all charges: initial purchase + all renewal charges
                    totalSpent: transactions
                        .filter((t) => t.completedAt)
                        .reduce((sum, t) => sum + (t.monthlyAmount * (1 + (t.renewalCount || 0))), 0),
                    transactions,
                },
            });
        } catch (error) {
            console.error("Error fetching payment history:", error);
            return res.status(500).json({ error: "Failed to fetch payment history" });
        }
    }

    /**
     * GET /api/payments/invoices
     * Get list of all invoices with optional filtering and search
     * Query params:
     * - limit: number of invoices to return (default 20)
     * - search: search by invoice number or package name
     * - dateFrom: filter invoices from this date (ISO string)
     * - dateTo: filter invoices until this date (ISO string)
     * - minAmount: filter invoices with amount >= minAmount
     * - maxAmount: filter invoices with amount <= maxAmount
     */
    static async getInvoices(req: Request, res: Response) {
        try {
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ error: "Unauthorized" });
            }

            const limit = parseInt(req.query.limit as string) || 20;
            const search = (req.query.search as string)?.toLowerCase().trim() || "";
            const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom as string) : null;
            const dateTo = req.query.dateTo ? new Date(req.query.dateTo as string) : null;
            const minAmount = req.query.minAmount ? parseFloat(req.query.minAmount as string) : null;
            const maxAmount = req.query.maxAmount ? parseFloat(req.query.maxAmount as string) : null;

            // Build where clause
            const whereClause: any = {
                user_id: userId,
                status: "completed",
            };

            // Add date range filtering
            if (dateFrom || dateTo) {
                whereClause.completed_at = {};
                if (dateFrom) {
                    whereClause.completed_at.gte = dateFrom;
                }
                if (dateTo) {
                    const endOfDay = new Date(dateTo);
                    endOfDay.setHours(23, 59, 59, 999);
                    whereClause.completed_at.lte = endOfDay;
                }
            }

            // Get subscriptions to show as invoices (without amount filtering first)
            const subscriptions = await prisma.user_credit_purchase.findMany({
                where: whereClause,
                include: { package: true },
                orderBy: { completed_at: "desc" },
                take: limit * 2, // Fetch more to account for filtering
            });

            // Map and apply client-side filtering for search and amount
            let invoices = subscriptions
                .map((sub, index) => ({
                    id: `INV-${Date.now()}-${sub.id}`,
                    subscriptionId: sub.id,
                    invoiceNumber: `INV-${subscriptions.length - index}`,
                    packageName: sub.package.name,
                    credits: sub.amount,
                    monthlyAmount: sub.price_usd,
                    // Total amount charged including all renewal charges
                    totalAmount: sub.price_usd * (1 + (sub.renewalCount || 0)),
                    issueDate: sub.completed_at,
                    dueDate: sub.completed_at,
                    status: "paid",
                    renewalNumber: sub.renewalCount || 0,
                    nextBillingDate: sub.nextRenewalDate,
                }))
                .filter((invoice) => {
                    // Search filter
                    if (search) {
                        const searchMatch =
                            invoice.invoiceNumber.toLowerCase().includes(search) ||
                            invoice.packageName.toLowerCase().includes(search);
                        if (!searchMatch) return false;
                    }

                    // Amount filtering
                    if (minAmount !== null && invoice.totalAmount < minAmount) return false;
                    if (maxAmount !== null && invoice.totalAmount > maxAmount) return false;

                    return true;
                })
                .slice(0, limit);

            return res.status(200).json({
                success: true,
                data: {
                    userId,
                    totalInvoices: invoices.length,
                    invoices,
                },
            });
        } catch (error) {
            console.error("Error fetching invoices:", error);
            return res.status(500).json({ error: "Failed to fetch invoices" });
        }
    }

    /**
     * GET /api/payments/invoices/:subscriptionId/preview
     * Get invoice preview (HTML)
     */
    static async getInvoicePreview(req: Request, res: Response) {
        try {
            const { subscriptionId } = req.params;
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ error: "Unauthorized" });
            }

            // Get subscription details
            const subscription = await prisma.user_credit_purchase.findUnique({
                where: { id: subscriptionId },
                include: { user: true, package: true },
            });

            if (!subscription) {
                return res.status(404).json({ error: "Subscription not found" });
            }

            // Verify ownership
            if (subscription.user_id !== userId) {
                return res.status(403).json({
                    error: "You do not have access to this invoice",
                });
            }

            const invoiceData = {
                invoiceId: `INV-${subscription.id}`,
                subscriptionId: subscription.id,
                userId: subscription.user_id,
                packageName: subscription.package.name,
                credits: subscription.amount,
                amount: subscription.price_usd,
                currency: "usd",
                issueDate: subscription.completed_at || new Date(),
                dueDate: subscription.completed_at || new Date(),
                renewalNumber: subscription.renewalCount || 0,
                userName: subscription.user.name || "Valued Customer",
                userEmail: subscription.user.email,
                companyName: "Elevated Spaces",
            };

            const invoiceHTML = InvoiceService.generateInvoiceHTML(invoiceData);

            return res.status(200).json({
                success: true,
                data: {
                    subscriptionId,
                    invoiceId: invoiceData.invoiceId,
                    html: invoiceHTML,
                },
            });
        } catch (error) {
            console.error("Error generating invoice preview:", error);
            return res.status(500).json({
                error: "Failed to generate invoice preview",
            });
        }
    }

    /**
     * GET /api/payments/summary
     * Get payment summary/stats
     */
    static async getPaymentSummary(req: Request, res: Response) {
        try {
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ error: "Unauthorized" });
            }

            // Get all purchases
            const purchases = await prisma.user_credit_purchase.findMany({
                where: { user_id: userId },
                include: { package: true },
            });

            const completed = purchases.filter((p) => p.status === "completed");
            const pending = purchases.filter((p) => p.status === "pending");
            const failed = purchases.filter((p) => p.status === "failed");
            const active = purchases.filter(
                (p) => p.autoRenewEnabled && !p.cancelledAt
            );
            const cancelled = purchases.filter((p) => p.cancelledAt);

            // Total spent includes initial purchases + all renewal charges
            const totalSpent = completed.reduce(
                (sum, p) => sum + (p.price_usd * (1 + p.renewalCount)),
                0
            );
            const totalCredits = completed.reduce((sum, p) => sum + p.amount, 0);
            const totalRenewals = completed.reduce(
                (sum, p) => sum + p.renewalCount,
                0
            );

            return res.status(200).json({
                success: true,
                data: {
                    summary: {
                        totalPurchases: purchases.length,
                        totalSpent: parseFloat(totalSpent.toFixed(2)),
                        totalCredits,
                        totalRenewals,
                        averageTransactionValue: parseFloat(
                            (totalSpent / completed.length || 0).toFixed(2)
                        ),
                    },
                    breakdown: {
                        completed: completed.length,
                        pending: pending.length,
                        failed: failed.length,
                        active: active.length,
                        cancelled: cancelled.length,
                    },
                    activeSubscriptions: active.map((sub) => ({
                        id: sub.id,
                        package: sub.package.name,
                        credits: sub.amount,
                        monthlyAmount: sub.price_usd,
                        nextRenewal: sub.nextRenewalDate,
                        renewals: sub.renewalCount,
                    })),
                    recentTransactions: completed.slice(0, 5).map((p) => ({
                        id: p.id,
                        package: p.package.name,
                        amount: p.price_usd,
                        date: p.completed_at,
                    })),
                },
            });
        } catch (error) {
            console.error("Error fetching payment summary:", error);
            return res.status(500).json({
                error: "Failed to fetch payment summary",
            });
        }
    }
}

export default PaymentHistoryController;
