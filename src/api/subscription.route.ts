import { Router } from "express";
import SubscriptionController from "../controllers/subscription.controller";
import { requireAuth } from "../middlewares/auth"

const router = Router();

/**
 * Subscription Management Routes
 * All routes require authentication
 */

// Get all user subscriptions
router.get("/", requireAuth, SubscriptionController.getUserSubscriptions);

// Get specific subscription details
router.get(
    "/:subscriptionId",
    requireAuth,
    SubscriptionController.getSubscriptionDetails
);

// Enable auto-renewal
router.post(
    "/:subscriptionId/enable-renewal",
    requireAuth,
    SubscriptionController.enableAutoRenewal
);

// Disable auto-renewal
router.post(
    "/:subscriptionId/disable-renewal",
    requireAuth,
    SubscriptionController.disableAutoRenewal
);

// Cancel subscription
router.post(
    "/:subscriptionId/cancel",
    requireAuth,
    SubscriptionController.cancelSubscription
);

export default router;
