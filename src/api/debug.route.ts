import { Router } from "express";
import SubscriptionRenewalService from "../services/subscription-renewal.service";

const router = Router();

/**
 * DEBUG ENDPOINTS - For testing only
 * Remove or protect these in production
 */

/**
 * POST /debug/trigger-renewal
 * Manually trigger subscription renewal processing
 * TESTING ONLY - Remove in production
 */
router.post("/trigger-renewal", async (req, res) => {
    try {
        const result = await SubscriptionRenewalService.processPendingRenewals();
        return res.status(200).json({
            success: true,
            message: "Renewal processing triggered",
            result,
        });
    } catch (error) {
        console.error("Error triggering renewal:", error);
        return res.status(500).json({
            error: "Failed to trigger renewal",
            details: error instanceof Error ? error.message : "Unknown error",
        });
    }
});

/**
 * POST /debug/set-renewal-now/:subscriptionId
 * Set a subscription's renewal date to now (for testing)
 * TESTING ONLY
 */
router.post("/set-renewal-now/:subscriptionId", async (req, res) => {
    try {
        const { subscriptionId } = req.params;

        const prisma = (await import("../dbConnection")).default;

        const updated = await prisma.user_credit_purchase.update({
            where: { id: subscriptionId },
            data: {
                nextRenewalDate: new Date(Date.now() - 1000), // 1 second ago
            },
        });

        return res.status(200).json({
            success: true,
            message: "Renewal date set to NOW",
            data: {
                subscriptionId: updated.id,
                nextRenewalDate: updated.nextRenewalDate,
            },
        });
    } catch (error) {
        console.error("Error setting renewal date:", error);
        return res.status(500).json({
            error: "Failed to set renewal date",
            details: error instanceof Error ? error.message : "Unknown error",
        });
    }
});

/**
 * GET /debug/subscriptions
 * List all subscriptions (for debugging)
 * TESTING ONLY
 */
router.get("/subscriptions", async (req, res) => {
    try {
        const prisma = (await import("../dbConnection")).default;

        const subscriptions = await prisma.user_credit_purchase.findMany({
            include: { user: true, package: true },
            orderBy: { created_at: "desc" },
            take: 20,
        });

        return res.status(200).json({
            success: true,
            count: subscriptions.length,
            data: subscriptions.map((sub) => ({
                id: sub.id,
                userId: sub.user_id,
                email: sub.user?.email,
                package: sub.package?.name,
                amount: sub.amount,
                price: sub.price_usd,
                status: sub.status,
                autoRenewEnabled: sub.autoRenewEnabled,
                nextRenewalDate: sub.nextRenewalDate,
                renewalCount: sub.renewalCount,
                cancelledAt: sub.cancelledAt,
                createdAt: sub.created_at,
            })),
        });
    } catch (error) {
        console.error("Error fetching subscriptions:", error);
        return res.status(500).json({
            error: "Failed to fetch subscriptions",
        });
    }
});

export default router;
