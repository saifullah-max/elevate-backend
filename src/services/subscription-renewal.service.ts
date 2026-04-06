import prisma from "../dbConnection";
import Stripe from "stripe";
import { sendEmail } from "../config/mail.config";
import InvoiceService, { InvoiceData } from "./invoice.service";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_API_VERSION = "2025-12-15.clover";

if (!STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });

export interface RenewalResult {
    success: boolean;
    message: string;
    subscriptionId?: string;
    error?: string;
}

const SUBSCRIPTION_INTERVAL_DAYS = Math.max(
    1,
    Number(process.env.SUBSCRIPTION_INTERVAL_DAYS || "30")
);

function addDays(base: Date, days: number): Date {
    const result = new Date(base);
    result.setDate(result.getDate() + days);
    return result;
}

function getFirstPaymentDate(subscription: {
    completed_at?: Date | null;
    created_at: Date;
}): Date {
    return subscription.completed_at || subscription.created_at;
}

function getLastPaymentDate(subscription: {
    renewalCount: number;
    nextRenewalDate?: Date | null;
    completed_at?: Date | null;
    created_at: Date;
}): Date {
    if (subscription.nextRenewalDate) {
        return addDays(subscription.nextRenewalDate, -SUBSCRIPTION_INTERVAL_DAYS);
    }

    if (subscription.renewalCount > 0) {
        return subscription.completed_at || subscription.created_at;
    }

    return subscription.completed_at || subscription.created_at;
}

function isDatabaseUnavailableError(error: any): boolean {
    if (!error) return false;

    const message = String(error?.message || "").toLowerCase();
    const code = String(error?.code || "");

    return (
        code === "P1001" ||
        message.includes("can't reach database server") ||
        message.includes("databasenotreachable")
    );
}

/**
 * Subscription Renewal Service
 * Handles automatic monthly renewal of credit packages and subscription management
 */
export class SubscriptionRenewalService {
    private static async enforceSingleActiveAutoRenewalPerUser() {
        const activeSubscriptions = await prisma.user_credit_purchase.findMany({
            where: {
                autoRenewEnabled: true,
                cancelledAt: null,
                status: "completed",
            },
            orderBy: [{ user_id: "asc" }, { created_at: "desc" }],
            select: {
                id: true,
                user_id: true,
            },
        });

        const keepByUser = new Set<string>();
        const subscriptionsToDisable: string[] = [];

        for (const subscription of activeSubscriptions) {
            if (keepByUser.has(subscription.user_id)) {
                subscriptionsToDisable.push(subscription.id);
                continue;
            }
            keepByUser.add(subscription.user_id);
        }

        if (subscriptionsToDisable.length === 0) {
            return;
        }

        const result = await prisma.user_credit_purchase.updateMany({
            where: { id: { in: subscriptionsToDisable } },
            data: {
                autoRenewEnabled: false,
                nextRenewalDate: null,
                cancelledAt: new Date(),
                cancellationReason: "Replaced by newer subscription purchase",
            },
        });

        console.warn(
            `[processPendingRenewals] Disabled ${result.count} older active auto-renew subscriptions.`
        );
    }

    /**
     * Process all pending renewals that are due
     * Called via cron job daily
     */
    static async processPendingRenewals(): Promise<{
        processed: number;
        successful: number;
        failed: number;
    }> {
        const now = new Date();
        let processed = 0;
        let successful = 0;
        let failed = 0;

        try {
            await this.enforceSingleActiveAutoRenewalPerUser();

            const invalidRenewalDateSubscriptions = await prisma.user_credit_purchase.findMany({
                where: {
                    autoRenewEnabled: true,
                    cancelledAt: null,
                    status: "completed",
                    nextRenewalDate: null,
                },
                select: {
                    id: true,
                    completed_at: true,
                    created_at: true,
                    nextRenewalDate: true,
                    renewalCount: true,
                },
            });

            if (invalidRenewalDateSubscriptions.length > 0) {
                console.warn(
                    `[processPendingRenewals] Found ${invalidRenewalDateSubscriptions.length} active subscriptions with null nextRenewalDate. Backfilling dates.`
                );

                await Promise.all(
                    invalidRenewalDateSubscriptions.map((subscription) => {
                        const baseDate = getLastPaymentDate(subscription);
                        const nextRenewalDate = addDays(baseDate, SUBSCRIPTION_INTERVAL_DAYS);

                        return prisma.user_credit_purchase.update({
                            where: { id: subscription.id },
                            data: { nextRenewalDate },
                        });
                    })
                );
            }

            // Find all active auto-renewal subscriptions where renewal date has passed
            const dueRenewals = await prisma.user_credit_purchase.findMany({
                where: {
                    autoRenewEnabled: true,
                    cancelledAt: null,
                    status: "completed",
                    nextRenewalDate: {
                        lte: now,
                    },
                },
                orderBy: [{ user_id: "asc" }, { created_at: "desc" }],
                include: {
                    user: true,
                    package: true,
                },
            });

            const dueRenewalsByUser: typeof dueRenewals = [];
            const seenUsers = new Set<string>();

            for (const subscription of dueRenewals) {
                if (seenUsers.has(subscription.user_id)) {
                    continue;
                }
                seenUsers.add(subscription.user_id);
                dueRenewalsByUser.push(subscription);
            }

            console.log(
                `Found ${dueRenewals.length} subscriptions due for renewal (${dueRenewalsByUser.length} unique users to process)`
            );

            const completedNonAutoSubscriptions = await prisma.user_credit_purchase.findMany({
                where: {
                    autoRenewEnabled: false,
                    cancelledAt: null,
                    status: "completed",
                },
                include: {
                    user: true,
                    package: true,
                },
            });

            const dueCancellations = completedNonAutoSubscriptions.filter((subscription) => {
                const firstPaymentDate = getFirstPaymentDate(subscription);
                const expiryDate = addDays(firstPaymentDate, SUBSCRIPTION_INTERVAL_DAYS);
                return expiryDate <= now;
            });

            console.log(
                `Found ${dueCancellations.length} non-auto subscriptions due for cancellation after ${SUBSCRIPTION_INTERVAL_DAYS} days`
            );

            for (const subscription of dueRenewalsByUser) {
                processed++;
                try {
                    const result = await this.renewSubscription(subscription);
                    if (result.success) {
                        successful++;
                    } else {
                        failed++;
                        console.error(
                            `Renewal failed for subscription ${subscription.id}: ${result.error}`
                        );
                    }
                } catch (error) {
                    failed++;
                    console.error(
                        `Exception during renewal for subscription ${subscription.id}:`,
                        error
                    );
                }
            }

            for (const subscription of dueCancellations) {
                processed++;
                try {
                    const result = await this.expireNonAutoRenewSubscription(subscription);
                    if (result.success) {
                        successful++;
                    } else {
                        failed++;
                        console.error(
                            `Cancellation failed for non-auto subscription ${subscription.id}: ${result.error}`
                        );
                    }
                } catch (error) {
                    failed++;
                    console.error(
                        `Exception during cancellation for non-auto subscription ${subscription.id}:`,
                        error
                    );
                }
            }

            console.log(
                `Renewal processing complete. Processed: ${processed}, Successful: ${successful}, Failed: ${failed}`
            );

            return { processed, successful, failed };
        } catch (error) {
            if (isDatabaseUnavailableError(error)) {
                console.warn(
                    "[processPendingRenewals] Database unreachable (P1001). Skipping this cycle and retrying on next schedule."
                );
                return { processed: 0, successful: 0, failed: 0 };
            }

            console.error("Error in processPendingRenewals:", error);
            throw error;
        }
    }

    /**
     * Renew a single subscription by charging the user again
     */
    static async renewSubscription(subscription: any): Promise<RenewalResult> {
        try {
            const { user, package: creditPackage, price_usd, id } = subscription;
            const renewalCredits = Number(subscription.amount || creditPackage.credits || 0);

            if (!user.stripe_customer_id) {
                return {
                    success: false,
                    message: "User has no Stripe customer ID",
                    error: "No Stripe customer ID",
                };
            }

            const stripeCustomer = await stripe.customers.retrieve(user.stripe_customer_id);
            let defaultPaymentMethodId: string | null = null;

            if (!("deleted" in stripeCustomer) || !stripeCustomer.deleted) {
                const invoiceDefault = stripeCustomer.invoice_settings?.default_payment_method;
                if (typeof invoiceDefault === "string") {
                    defaultPaymentMethodId = invoiceDefault;
                }
            }

            if (!defaultPaymentMethodId) {
                const paymentMethods = await stripe.paymentMethods.list({
                    customer: user.stripe_customer_id,
                    type: "card",
                    limit: 1,
                });

                defaultPaymentMethodId = paymentMethods.data[0]?.id || null;

                if (defaultPaymentMethodId) {
                    await stripe.customers.update(user.stripe_customer_id, {
                        invoice_settings: {
                            default_payment_method: defaultPaymentMethodId,
                        },
                    });
                }
            }

            if (!defaultPaymentMethodId) {
                return {
                    success: false,
                    message: "No saved payment method for customer",
                    error: "Customer has no default/saved card. Ask user to complete a new checkout to save a payment method.",
                };
            }

            // Create a payment intent to charge the user
            const paymentIntent = await stripe.paymentIntents.create({
                customer: user.stripe_customer_id,
                amount: Math.round(price_usd * 100), // Convert to cents
                currency: "usd",
                payment_method: defaultPaymentMethodId,
                description: `${creditPackage.name} - Auto Renewal`,
                metadata: {
                    packageId: creditPackage.id,
                    subscriptionId: id,
                    renewalType: "auto",
                },
                off_session: true, // Charge stored payment method
                confirm: true, // Required when using off_session
            });

            if (paymentIntent.status !== "succeeded") {
                return {
                    success: false,
                    message: "Payment intent failed",
                    error: paymentIntent.last_payment_error?.message || "Unknown payment error",
                };
            }

            // Next charge should happen after an exact interval from this successful payment.
            const nextRenewalDate = addDays(new Date(), SUBSCRIPTION_INTERVAL_DAYS);

            await prisma.$transaction([
                prisma.user_credit_purchase.update({
                    where: { id },
                    data: {
                        renewalCount: subscription.renewalCount + 1,
                        nextRenewalDate,
                        stripe_invoice_id: paymentIntent.id,
                    },
                }),
                prisma.user_credit_balance.upsert({
                    where: { user_id: user.id },
                    create: { user_id: user.id, balance: renewalCredits },
                    update: { balance: { increment: renewalCredits } },
                }),
            ]);

            let emailWarning: string | null = null;

            try {
                const invoiceId = `INV-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
                const invoiceData: InvoiceData = {
                    invoiceId,
                    subscriptionId: id,
                    userId: user.id,
                    packageName: creditPackage.name,
                    credits: creditPackage.credits,
                    amount: price_usd,
                    currency: "usd",
                    issueDate: new Date(),
                    dueDate: new Date(),
                    renewalNumber: subscription.renewalCount + 1,
                    userName: user.name || "Valued Customer",
                    userEmail: user.email,
                    companyName: "Elevated Spaces",
                };

                const invoiceHTML = InvoiceService.generateInvoiceHTML(invoiceData);

                await sendEmail({
                    from: "noreply@elevatedspaces.com",
                    senderName: "Elevated Spaces",
                    to: user.email,
                    subject: `Invoice #${invoiceId} - ${creditPackage.name} Subscription Renewal`,
                    text: `Your ${creditPackage.name} subscription renewal invoice for $${price_usd.toFixed(2)} is ready. Thank you for your business!`,
                    html: invoiceHTML,
                });
            } catch (emailError) {
                emailWarning =
                    emailError instanceof Error
                        ? emailError.message
                        : "Invoice email failed";
                console.warn(
                    `Renewal succeeded but invoice email failed for subscription ${id}: ${emailWarning}`
                );
            }

            console.log(
                `Successfully renewed subscription ${id} for user ${user.id}`
            );

            return {
                success: true,
                message: emailWarning
                    ? `Subscription renewed successfully (email warning: ${emailWarning})`
                    : "Subscription renewed successfully",
                subscriptionId: id,
            };
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            return {
                success: false,
                message: "Renewal failed",
                error: errorMessage,
            };
        }
    }

    private static async expireNonAutoRenewSubscription(subscription: any): Promise<RenewalResult> {
        try {
            const firstPaymentDate = getFirstPaymentDate(subscription);
            const expiryDate = addDays(firstPaymentDate, SUBSCRIPTION_INTERVAL_DAYS);

            await prisma.user_credit_purchase.update({
                where: { id: subscription.id },
                data: {
                    cancelledAt: new Date(),
                    cancellationReason: `Auto-renew disabled; subscription expired after ${SUBSCRIPTION_INTERVAL_DAYS} days from initial payment`,
                    nextRenewalDate: null,
                },
            });

            await sendEmail({
                from: "noreply@elevatedspaces.com",
                senderName: "Elevated Spaces",
                to: subscription.user.email,
                subject: "Subscription Expired - Auto Renewal Disabled",
                text: `Your ${subscription.package.name} subscription has ended because auto-renewal was disabled. It expired ${SUBSCRIPTION_INTERVAL_DAYS} days after your first payment.`,
                html: `
                    <h2>Subscription Expired</h2>
                    <p>Hi ${subscription.user.name || "there"},</p>
                    <p>Your <strong>${subscription.package.name}</strong> subscription has been cancelled because auto-renewal is disabled.</p>
                    <ul>
                        <li>First payment date: ${firstPaymentDate.toLocaleDateString()}</li>
                        <li>Expiry date: ${expiryDate.toLocaleDateString()}</li>
                        <li>Policy: ${SUBSCRIPTION_INTERVAL_DAYS} days from first payment when auto-renew is off</li>
                    </ul>
                    <p>If you want to continue, you can purchase a new package anytime from your account.</p>
                `,
            });

            console.log(
                `Cancelled non-auto subscription ${subscription.id} for user ${subscription.user.id} after ${SUBSCRIPTION_INTERVAL_DAYS} days from first payment`
            );

            return {
                success: true,
                message: "Non-auto subscription cancelled after expiry",
                subscriptionId: subscription.id,
            };
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            return {
                success: false,
                message: "Failed to cancel expired non-auto subscription",
                error: errorMessage,
            };
        }
    }

    /**
     * Enable auto-renewal for a subscription
     */
    static async enableAutoRenewal(subscriptionId: string): Promise<RenewalResult> {
        try {
            const targetSubscription = await prisma.user_credit_purchase.findUnique({
                where: { id: subscriptionId },
                select: { user_id: true },
            });

            if (!targetSubscription) {
                return {
                    success: false,
                    message: "Subscription not found",
                    error: "Not found",
                };
            }

            await prisma.user_credit_purchase.updateMany({
                where: {
                    user_id: targetSubscription.user_id,
                    id: { not: subscriptionId },
                    autoRenewEnabled: true,
                    cancelledAt: null,
                    status: "completed",
                },
                data: {
                    autoRenewEnabled: false,
                    nextRenewalDate: null,
                    cancelledAt: new Date(),
                    cancellationReason: "Replaced by newer subscription purchase",
                },
            });

            const subscription = await prisma.user_credit_purchase.findUnique({
                where: { id: subscriptionId },
                select: {
                    renewalCount: true,
                    nextRenewalDate: true,
                    completed_at: true,
                    created_at: true,
                },
            });

            if (!subscription) {
                return {
                    success: false,
                    message: "Subscription not found",
                    error: "Not found",
                };
            }

            const lastPaymentDate = getLastPaymentDate(subscription);
            const nextRenewalDate = addDays(lastPaymentDate, SUBSCRIPTION_INTERVAL_DAYS);

            await prisma.user_credit_purchase.update({
                where: { id: subscriptionId },
                data: {
                    autoRenewEnabled: true,
                    nextRenewalDate,
                    cancelledAt: null, // Clear cancellation if previously cancelled
                },
            });

            console.log(
                `Auto-renewal enabled for subscription ${subscriptionId}`
            );

            return {
                success: true,
                message: "Auto-renewal enabled",
                subscriptionId,
            };
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            return {
                success: false,
                message: "Failed to enable auto-renewal",
                error: errorMessage,
            };
        }
    }

    /**
     * Disable auto-renewal for a subscription
     */
    static async disableAutoRenewal(subscriptionId: string): Promise<RenewalResult> {
        try {
            await prisma.user_credit_purchase.update({
                where: { id: subscriptionId },
                data: {
                    autoRenewEnabled: false,
                    nextRenewalDate: null,
                },
            });

            console.log(
                `Auto-renewal disabled for subscription ${subscriptionId}`
            );

            return {
                success: true,
                message: "Auto-renewal disabled",
                subscriptionId,
            };
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            return {
                success: false,
                message: "Failed to disable auto-renewal",
                error: errorMessage,
            };
        }
    }

    /**
     * Cancel a subscription immediately
     */
    static async cancelSubscription(
        subscriptionId: string,
        reason?: string
    ): Promise<RenewalResult> {
        try {
            const subscription = await prisma.user_credit_purchase.findUnique({
                where: { id: subscriptionId },
                include: { user: true, package: true },
            });

            if (!subscription) {
                return {
                    success: false,
                    message: "Subscription not found",
                    error: "Not found",
                };
            }

            const now = new Date();

            await prisma.user_credit_purchase.update({
                where: { id: subscriptionId },
                data: {
                    autoRenewEnabled: false,
                    cancelledAt: now,
                    cancellationReason: reason || "User requested cancellation",
                    nextRenewalDate: null,
                },
            });

            // Send cancellation confirmation email
            await sendEmail({
                from: "noreply@elevatedspaces.com",
                senderName: "Elevated Spaces",
                to: subscription.user.email,
                subject: "Your Subscription Has Been Cancelled",
                text: `Your ${subscription.package.name} subscription has been cancelled. Your remaining credits will continue to work until they are exhausted.`,
                html: `
                    <h2>Subscription Cancellation Confirmation</h2>
                    <p>Hi ${subscription.user.name},</p>
                    <p>Your ${subscription.package.name} subscription has been cancelled.</p>
                    <p><strong>Cancellation Details:</strong></p>
                    <ul>
                        <li>Package: ${subscription.package.name}</li>
                        <li>Cancelled on: ${now.toLocaleDateString()}</li>
                        <li>Remaining Credits: ${subscription.amount}</li>
                        ${reason ? `<li>Reason: ${reason}</li>` : ""}
                    </ul>
                    <p>Your remaining credits will continue to work until they are exhausted.</p>
                    <p>If you would like to reactivate your subscription, you can do so anytime from your account settings.</p>
                `,
            });

            console.log(
                `Subscription ${subscriptionId} cancelled for user ${subscription.user.id}. Reason: ${reason || "Not provided"}`
            );

            return {
                success: true,
                message: "Subscription cancelled successfully",
                subscriptionId,
            };
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : "Unknown error";
            return {
                success: false,
                message: "Failed to cancel subscription",
                error: errorMessage,
            };
        }
    }

    /**
     * Get subscription details for a user
     */
    static async getSubscriptionDetails(subscriptionId: string) {
        try {
            const subscription = await prisma.user_credit_purchase.findUnique({
                where: { id: subscriptionId },
                include: {
                    user: {
                        select: {
                            id: true,
                            email: true,
                            name: true,
                        },
                    },
                    package: true,
                },
            });

            if (!subscription) {
                return null;
            }

            return {
                id: subscription.id,
                packageName: subscription.package.name,
                credits: subscription.amount,
                price: subscription.price_usd,
                autoRenewEnabled: subscription.autoRenewEnabled,
                nextRenewalDate: subscription.nextRenewalDate,
                renewalCount: subscription.renewalCount,
                cancelledAt: subscription.cancelledAt,
                cancellationReason: subscription.cancellationReason,
                createdAt: subscription.created_at,
                completedAt: subscription.completed_at,
                user: subscription.user,
            };
        } catch (error) {
            console.error("Error fetching subscription details:", error);
            throw error;
        }
    }

    /**
     * Get all active subscriptions for a user
     */
    static async getUserSubscriptions(userId: string) {
        try {
            const subscriptions = await prisma.user_credit_purchase.findMany({
                where: {
                    user_id: userId,
                    status: "completed",
                },
                include: {
                    package: true,
                },
                orderBy: {
                    created_at: "desc",
                },
            });

            return subscriptions.map((sub) => ({
                id: sub.id,
                packageName: sub.package.name,
                credits: sub.amount,
                price: sub.price_usd,
                autoRenewEnabled: sub.autoRenewEnabled,
                nextRenewalDate: sub.nextRenewalDate,
                renewalCount: sub.renewalCount,
                cancelledAt: sub.cancelledAt,
                cancellationReason: sub.cancellationReason,
                createdAt: sub.created_at,
            }));
        } catch (error) {
            console.error("Error fetching user subscriptions:", error);
            throw error;
        }
    }
}

export default SubscriptionRenewalService;
