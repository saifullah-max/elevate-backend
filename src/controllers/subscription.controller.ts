import { Request, Response } from "express";
import SubscriptionRenewalService from "../services/subscription-renewal.service";

/**
 * Subscription Management Controller
 * Handles auto-renewal and cancellation operations
 */
export class SubscriptionController {
    /**
     * GET /api/subscriptions
     * Get all subscriptions for the authenticated user
     */
    static async getUserSubscriptions(req: Request, res: Response) {
        try {
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ error: "Unauthorized" });
            }

            const subscriptions =
                await SubscriptionRenewalService.getUserSubscriptions(userId);

            return res.status(200).json({
                success: true,
                data: subscriptions,
            });
        } catch (error) {
            console.error("Error fetching user subscriptions:", error);
            return res.status(500).json({
                error: "Failed to fetch subscriptions",
            });
        }
    }

    /**
     * GET /api/subscriptions/:subscriptionId
     * Get details for a specific subscription
     */
    static async getSubscriptionDetails(req: Request, res: Response) {
        try {
            const { subscriptionId } = req.params;
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ error: "Unauthorized" });
            }

            const subscription =
                await SubscriptionRenewalService.getSubscriptionDetails(
                    subscriptionId
                );

            if (!subscription) {
                return res.status(404).json({ error: "Subscription not found" });
            }

            // Verify user owns this subscription
            if (subscription.user.id !== userId) {
                return res.status(403).json({
                    error: "You do not have access to this subscription",
                });
            }

            return res.status(200).json({
                success: true,
                data: subscription,
            });
        } catch (error) {
            console.error("Error fetching subscription details:", error);
            return res.status(500).json({
                error: "Failed to fetch subscription details",
            });
        }
    }

    /**
     * POST /api/subscriptions/:subscriptionId/enable-renewal
     * Enable auto-renewal for a subscription
     */
    static async enableAutoRenewal(req: Request, res: Response) {
        try {
            const { subscriptionId } = req.params;
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ error: "Unauthorized" });
            }

            // Verify user owns this subscription
            const subscription =
                await SubscriptionRenewalService.getSubscriptionDetails(
                    subscriptionId
                );

            if (!subscription) {
                return res.status(404).json({ error: "Subscription not found" });
            }

            if (subscription.user.id !== userId) {
                return res.status(403).json({
                    error: "You do not have access to this subscription",
                });
            }

            const result =
                await SubscriptionRenewalService.enableAutoRenewal(
                    subscriptionId
                );

            if (!result.success) {
                return res.status(400).json({
                    error: result.message,
                    details: result.error,
                });
            }

            console.log(
                `User ${userId} enabled auto-renewal for subscription ${subscriptionId}`
            );

            return res.status(200).json({
                success: true,
                message: result.message,
                subscriptionId: result.subscriptionId,
            });
        } catch (error) {
            console.error("Error enabling auto-renewal:", error);
            return res.status(500).json({
                error: "Failed to enable auto-renewal",
            });
        }
    }

    /**
     * POST /api/subscriptions/:subscriptionId/disable-renewal
     * Disable auto-renewal for a subscription
     */
    static async disableAutoRenewal(req: Request, res: Response) {
        try {
            const { subscriptionId } = req.params;
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ error: "Unauthorized" });
            }

            // Verify user owns this subscription
            const subscription =
                await SubscriptionRenewalService.getSubscriptionDetails(
                    subscriptionId
                );

            if (!subscription) {
                return res.status(404).json({ error: "Subscription not found" });
            }

            if (subscription.user.id !== userId) {
                return res.status(403).json({
                    error: "You do not have access to this subscription",
                });
            }

            const result = await SubscriptionRenewalService.disableAutoRenewal(
                subscriptionId
            );

            if (!result.success) {
                return res.status(400).json({
                    error: result.message,
                    details: result.error,
                });
            }

            console.log(
                `User ${userId} disabled auto-renewal for subscription ${subscriptionId}`
            );

            return res.status(200).json({
                success: true,
                message: result.message,
                subscriptionId: result.subscriptionId,
            });
        } catch (error) {
            console.error("Error disabling auto-renewal:", error);
            return res.status(500).json({
                error: "Failed to disable auto-renewal",
            });
        }
    }

    /**
     * POST /api/subscriptions/:subscriptionId/cancel
     * Cancel a subscription immediately
     * Body: { reason?: string }
     */
    static async cancelSubscription(req: Request, res: Response) {
        try {
            const { subscriptionId } = req.params;
            const { reason } = req.body;
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ error: "Unauthorized" });
            }

            // Verify user owns this subscription
            const subscription =
                await SubscriptionRenewalService.getSubscriptionDetails(
                    subscriptionId
                );

            if (!subscription) {
                return res.status(404).json({ error: "Subscription not found" });
            }

            if (subscription.user.id !== userId) {
                return res.status(403).json({
                    error: "You do not have access to this subscription",
                });
            }

            if (subscription.cancelledAt) {
                return res.status(400).json({
                    error: "This subscription is already cancelled",
                });
            }

            const result = await SubscriptionRenewalService.cancelSubscription(
                subscriptionId,
                reason
            );

            if (!result.success) {
                return res.status(400).json({
                    error: result.message,
                    details: result.error,
                });
            }

            console.log(
                `User ${userId} cancelled subscription ${subscriptionId}. Reason: ${reason || "Not provided"}`
            );

            return res.status(200).json({
                success: true,
                message: result.message,
                subscriptionId: result.subscriptionId,
            });
        } catch (error) {
            console.error("Error cancelling subscription:", error);
            return res.status(500).json({
                error: "Failed to cancel subscription",
            });
        }
    }
}

export default SubscriptionController;
