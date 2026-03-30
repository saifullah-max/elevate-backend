import Stripe from "stripe";
import { Prisma } from "@prisma/client";
import prisma from "../dbConnection";
import { sendEmail } from "../config/mail.config";
import { loggingService } from "./logging.service";
import { DEMO_LIMIT, isNewMonth } from "../utils/demoTracking";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const STRIPE_API_VERSION = "2025-12-15.clover";

if (!STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });

const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
    "active",
    "trialing",
    "past_due",
    "unpaid",
]);

const PLAN_PRODUCT_KEYS = new Set(["starter", "pro", "team"]);

export type PurchaseFor = "individual" | "team";
export type ProductKey =
    | "starter"
    | "pro"
    | "team"
    | "virtual_staging"
    | "furnishing_addon"
    | "extra_credits_50"
    | "extra_credits_100"
    | "pay_per_image"
    | "subscription_topup";

const PRODUCT_CATALOG: Record<ProductKey, {
    name: string;
    type: "subscription" | "one_time";
    unitAmountUsd: number;
    credits?: number;
    creditsPerUnit?: number;
    interval?: "month";
}> = {
    starter: { name: "Starter", type: "subscription", unitAmountUsd: 25, credits: 60, interval: "month" },
    pro: { name: "Pro", type: "subscription", unitAmountUsd: 59, credits: 160, interval: "month" },
    team: { name: "Team", type: "subscription", unitAmountUsd: 119, credits: 360, interval: "month" },
    virtual_staging: { name: "Full Home Virtual Staging", type: "one_time", unitAmountUsd: 99.99 },
    furnishing_addon: { name: "Physical Furnishing Add-On", type: "one_time", unitAmountUsd: 39.99 },
    extra_credits_50: { name: "Extra Credits (50)", type: "one_time", unitAmountUsd: 22, credits: 50 },
    extra_credits_100: { name: "Extra Credits (100)", type: "one_time", unitAmountUsd: 40, credits: 100 },
    pay_per_image: { name: "Pay Per Image", type: "one_time", unitAmountUsd: 1.5, creditsPerUnit: 1 },
    subscription_topup: { name: "Subscription Top-Up Credits", type: "one_time", unitAmountUsd: 0, creditsPerUnit: 1 },
};

function getProductConfig(productKey: string) {
    const config = PRODUCT_CATALOG[productKey as ProductKey];
    if (!config) {
        throw new Error("Invalid product selection");
    }
    return config;
}

function toCents(amountUsd: number) {
    return Math.round(amountUsd * 100);
}

function calcCredits(config: ReturnType<typeof getProductConfig>, quantity: number) {
    if (config.creditsPerUnit) {
        return config.creditsPerUnit * quantity;
    }
    return config.credits || 0;
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

async function ensureStripeCustomer(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        throw new Error("User not found");
    }

    if (user.stripe_customer_id) {
        try {
            const existingCustomer = await stripe.customers.retrieve(user.stripe_customer_id);

            if (!("deleted" in existingCustomer && existingCustomer.deleted)) {
                return { user, customerId: user.stripe_customer_id };
            }
        } catch (error: any) {
            const isMissingCustomer =
                error?.type === "StripeInvalidRequestError" &&
                error?.code === "resource_missing";

            if (!isMissingCustomer) {
                throw error;
            }
        }
    }

    const customer = await stripe.customers.create({
        email: user.email,
        name: user.name || undefined,
        metadata: { userId: user.id },
    });

    await prisma.user.update({
        where: { id: user.id },
        data: { stripe_customer_id: customer.id },
    });

    return { user, customerId: customer.id };
}

async function listActiveSubscriptionsForScope({
    customerId,
    purchaseFor,
    teamId,
    userId,
}: {
    customerId: string;
    purchaseFor: PurchaseFor;
    teamId?: string;
    userId: string;
}) {
    const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
    });

    return subscriptions.data.filter((subscription) => {
        if (!ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
            return false;
        }

        const metadata = subscription.metadata || {};
        if (metadata.purchaseFor !== purchaseFor || metadata.userId !== userId) {
            return false;
        }

        if (purchaseFor === "team") {
            return metadata.teamId === teamId;
        }

        return !metadata.teamId;
    });
}

async function hasAnyPlanSubscriptionHistoryForScope({
    customerId,
    purchaseFor,
    teamId,
    userId,
}: {
    customerId: string;
    purchaseFor: PurchaseFor;
    teamId?: string;
    userId: string;
}) {
    const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
    });

    return subscriptions.data.some((subscription) => {
        const metadata = subscription.metadata || {};

        if (metadata.purchaseFor !== purchaseFor || metadata.userId !== userId) {
            return false;
        }

        if (purchaseFor === "team") {
            if (metadata.teamId !== teamId) {
                return false;
            }
        } else if (metadata.teamId) {
            return false;
        }

        const subscriptionProductKey = metadata.productKey;
        return typeof subscriptionProductKey === "string" && PLAN_PRODUCT_KEYS.has(subscriptionProductKey);
    });
}

async function cancelOtherActiveSubscriptions({
    customerId,
    purchaseFor,
    teamId,
    userId,
    keepSubscriptionId,
}: {
    customerId: string;
    purchaseFor: PurchaseFor;
    teamId?: string;
    userId: string;
    keepSubscriptionId: string;
}) {
    const activeSubscriptions = await listActiveSubscriptionsForScope({
        customerId,
        purchaseFor,
        teamId,
        userId,
    });

    const subscriptionsToCancel = activeSubscriptions.filter(
        (subscription) => subscription.id !== keepSubscriptionId
    );

    if (subscriptionsToCancel.length === 0) {
        return;
    }

    await Promise.all(
        subscriptionsToCancel.map(async (subscription) => {
            try {
                await stripe.subscriptions.cancel(subscription.id);
                console.log("[PAYMENT] Canceled previous subscription", {
                    subscriptionId: subscription.id,
                    purchaseFor,
                    teamId,
                    userId,
                });
            } catch (error: any) {
                console.error("[PAYMENT] Failed to cancel subscription", {
                    subscriptionId: subscription.id,
                    error: error?.message || error,
                });
            }
        })
    );
}

async function enforceSingleActiveAutoRenewalSubscription({
    userId,
    keepPurchaseId,
}: {
    userId: string;
    keepPurchaseId: string;
}) {
    await prisma.user_credit_purchase.updateMany({
        where: {
            user_id: userId,
            id: { not: keepPurchaseId },
            status: "completed",
            autoRenewEnabled: true,
            cancelledAt: null,
        },
        data: {
            autoRenewEnabled: false,
            nextRenewalDate: null,
            cancelledAt: new Date(),
            cancellationReason: "Replaced by newer subscription purchase",
        },
    });
}

async function assertTeamOwner(teamId: string, userId: string) {
    const team = await prisma.teams.findFirst({
        where: { id: teamId, deleted_at: null },
    });

    if (!team) {
        throw new Error("Team not found");
    }

    if (team.owner_id !== userId) {
        throw new Error("Only the team owner can purchase a team plan");
    }

    return team;
}

async function ensureCreditPackage({
    name,
    credits,
    price,
}: {
    name: string;
    credits: number;
    price: number;
}) {
    const existing = await prisma.credit_package.findFirst({ where: { name } });
    if (existing) {
        return existing;
    }

    return prisma.credit_package.create({
        data: {
            name,
            credits,
            price,
            currency: "usd",
            active: true,
        },
    });
}

export async function createCheckoutSession({
    userId,
    productKey,
    purchaseFor,
    teamId,
    quantity,
    confirmPlanChange,
}: {
    userId: string;
    productKey: string;
    purchaseFor: PurchaseFor;
    teamId?: string;
    quantity?: number;
    confirmPlanChange?: boolean;
}) {
    const isSubscriptionTopUp = productKey === "subscription_topup";
    const config = isSubscriptionTopUp ? null : getProductConfig(productKey);
    if (purchaseFor !== "individual" && purchaseFor !== "team") {
        throw new Error("Invalid purchase type");
    }
    const safeQuantity = Math.max(1, Math.min(quantity || 1, 1000));

    if (!isSubscriptionTopUp && config!.type === "subscription" && safeQuantity !== 1) {
        throw new Error("Subscriptions must have quantity of 1");
    }

    if (purchaseFor === "team") {
        if (!teamId) {
            throw new Error("Team ID is required for team purchases");
        }
        await assertTeamOwner(teamId, userId);
    }

    const { customerId } = await ensureStripeCustomer(userId);

    if (productKey === "furnishing_addon") {
        const hasSubscriptionHistory = await hasAnyPlanSubscriptionHistoryForScope({
            customerId,
            purchaseFor,
            teamId,
            userId,
        });

        if (!hasSubscriptionHistory) {
            const error: any = new Error(
                "Physical staging add-on can only be purchased after subscribing to a plan at least once."
            );
            error.code = "ADDON_SUBSCRIPTION_HISTORY_REQUIRED";
            throw error;
        }
    }

    const existingSubscriptions = !isSubscriptionTopUp && config!.type === "subscription"
        ? await listActiveSubscriptionsForScope({
            customerId,
            purchaseFor,
            teamId,
            userId,
        })
        : [];
    const replacingSubscriptionId = existingSubscriptions[0]?.id;

    if (!isSubscriptionTopUp && config!.type === "subscription" && existingSubscriptions.length > 0 && !confirmPlanChange) {
        const error: any = new Error(
            "You already have an active subscription. Changing plans will cancel the current plan and transfer any unused credits to your wallet. Confirm to proceed."
        );
        error.code = "PLAN_CHANGE_CONFIRMATION_REQUIRED";
        throw error;
    }

    let credits = 0;
    let unitAmount = 0;
    let totalAmount = 0;
    let productName = "";

    const metadata: Record<string, string> = {
        productKey,
        purchaseFor,
        userId,
        quantity: String(safeQuantity),
    };

    if (isSubscriptionTopUp) {
        const activeSubscriptions = await listActiveSubscriptionsForScope({
            customerId,
            purchaseFor,
            teamId,
            userId,
        });

        if (activeSubscriptions.length === 0) {
            throw new Error("An active subscription is required to buy credits at your plan rate");
        }

        const activeSubscription = activeSubscriptions[0];
        const subscriptionProductKey = activeSubscription.metadata?.productKey as ProductKey | undefined;
        const subscriptionConfig = subscriptionProductKey ? PRODUCT_CATALOG[subscriptionProductKey] : undefined;

        if (!subscriptionConfig || subscriptionConfig.type !== "subscription" || !subscriptionConfig.credits) {
            throw new Error("Unable to determine subscription credit rate for top-up");
        }

        const subscriptionUnitCents = toCents(subscriptionConfig.unitAmountUsd);
        const perCreditCents = Math.max(1, Math.round(subscriptionUnitCents / subscriptionConfig.credits));

        credits = safeQuantity;
        unitAmount = perCreditCents;
        totalAmount = unitAmount * safeQuantity;
        productName = `${subscriptionConfig.name} Top-Up Credits`;

        if (subscriptionProductKey) {
            metadata.subscriptionProductKey = subscriptionProductKey;
        }
        metadata.perCreditUsd = (unitAmount / 100).toFixed(2);
        metadata.topUp = "true";
    } else {
        credits = calcCredits(config!, safeQuantity);
        unitAmount = toCents(config!.unitAmountUsd);
        totalAmount = unitAmount * safeQuantity;
        productName = config!.name;
        metadata.productType = config!.type;

        if (productKey === "furnishing_addon") {
            metadata.productCategory = "addon";
        }
    }

    metadata.productName = productName;

    metadata.credits = String(credits);
    metadata.unitAmount = String(unitAmount);

    if (teamId) {
        metadata.teamId = teamId;
    }

    if (replacingSubscriptionId) {
        metadata.replacingSubscriptionId = replacingSubscriptionId;
    }

    const session = await stripe.checkout.sessions.create({
        mode: !isSubscriptionTopUp && config!.type === "subscription" ? "subscription" : "payment",
        customer: customerId,
        line_items: [
            {
                quantity: safeQuantity,
                price_data: {
                    currency: "usd",
                    unit_amount: unitAmount,
                    product_data: {
                        name: productName,
                    },
                    recurring: !isSubscriptionTopUp && config!.type === "subscription" ? { interval: config!.interval || "month" } : undefined,
                },
            },
        ],
        metadata,
        subscription_data: !isSubscriptionTopUp && config!.type === "subscription" ? { metadata } : undefined,
        success_url: `${FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_URL}/payment/error?type=cancelled`,
    });

    if (purchaseFor === "team" && teamId) {
        await prisma.team_purchase.create({
            data: {
                team_id: teamId,
                amount: credits,
                price_usd: totalAmount / 100,
                status: "pending",
                stripe_session_id: session.id,
            },
        });
    } else {
        if (credits > 0) {
            const packageRecord = await ensureCreditPackage({
                name: isSubscriptionTopUp ? "plan_subscription_topup" : `plan_${productKey}`,
                credits,
                price: totalAmount / 100,
            });

            await prisma.user_credit_purchase.create({
                data: {
                    user_id: userId,
                    package_id: packageRecord.id,
                    amount: credits,
                    price_usd: totalAmount / 100,
                    status: "pending",
                    stripe_session_id: session.id,
                },
            });
        } else {
            await prisma.payment.create({
                data: {
                    user_id: userId,
                    amount: totalAmount / 100,
                    currency: "usd",
                    status: "PENDING",
                    stripe_session_id: session.id,
                },
            });
        }
    }

    return { url: session.url };
}

function applyCreditsToUser(userId: string, credits: number) {
    return prisma.user_credit_balance.upsert({
        where: { user_id: userId },
        create: { user_id: userId, balance: credits },
        update: { balance: { increment: credits } },
    });
}

function applyCreditsToTeam(teamId: string, credits: number) {
    return prisma.teams.update({
        where: { id: teamId },
        data: { wallet: { increment: credits } },
    });
}

const SUBSCRIPTION_PLAN_PACKAGE_NAMES = ["plan_starter", "plan_pro", "plan_team"];

/**
 * Get remaining demo credits using unified tracking
 * Checks both user_demo_tracking AND linked guest_tracking
 * Returns the max(guest_count, user_count) to reflect actual unified usage
 */
async function getRemainingSignupDemoCredits(userId: string) {
    const now = new Date();

    // Get user demo tracking
    const userTracking = await prisma.user_demo_tracking.findUnique({
        where: { user_id: userId }
    });

    // Get linked guest tracking
    const guestTracking = await prisma.guest_tracking.findFirst({
        where: { userId }
    });

    // Calculate usage counts with monthly reset logic
    let userCount = 0;
    if (userTracking) {
        userCount = isNewMonth(userTracking.last_reset_at, now) ? 0 : userTracking.uploads_count;
    }

    let guestCount = 0;
    if (guestTracking) {
        guestCount = isNewMonth(guestTracking.last_used_at, now) ? 0 : guestTracking.uploads_count;
    }

    // Use the MAX of both counts (unified tracking)
    const unifiedCount = Math.max(userCount, guestCount);

    return Math.max(0, DEMO_LIMIT - unifiedCount);
}

async function getOneTimeDemoTransferCredits({
    userId,
    productKey,
    purchaseFor,
}: {
    userId: string;
    productKey: string;
    purchaseFor: PurchaseFor;
}) {
    if (purchaseFor !== "individual") {
        return 0;
    }

    if (!["starter", "pro", "team"].includes(productKey)) {
        return 0;
    }

    const completedSubscriptionPurchases = await prisma.user_credit_purchase.count({
        where: {
            user_id: userId,
            status: "completed",
            package: {
                name: {
                    in: SUBSCRIPTION_PLAN_PACKAGE_NAMES,
                },
            },
        },
    });

    if (completedSubscriptionPurchases > 0) {
        return 0;
    }

    return getRemainingSignupDemoCredits(userId);
}

export async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
    console.log('🔥🔥🔥 [PAYMENT] handleCheckoutCompleted - NEW CODE VERSION WITH MONGODB LOGGING 🔥🔥🔥');

    const metadata = session.metadata || {};
    const productKey = metadata.productKey;
    const purchaseFor = metadata.purchaseFor as PurchaseFor | undefined;
    const userId = metadata.userId;
    const teamId = metadata.teamId;
    const quantity = Number(metadata.quantity || 1);

    console.log(`[PAYMENT] handleCheckoutCompleted called:`, {
        sessionId: session.id,
        productKey,
        purchaseFor,
        userId,
        teamId,
        quantity,
        paymentStatus: session.payment_status,
        amountTotal: session.amount_total,
        metadata
    });

    // Extra debug log
    console.log('[DEBUG] Entered handleCheckoutCompleted, about to process payment logic');

    let credits = 0;
    let expectedAmount = 0;
    let productName = "";

    if (productKey === "subscription_topup") {
        credits = Number(metadata.credits || 0);
        expectedAmount = Number(metadata.unitAmount || 0) * quantity;
        productName = metadata.subscriptionProductKey
            ? `${metadata.subscriptionProductKey.toUpperCase()} Top-Up Credits`
            : "Subscription Top-Up Credits";
    } else {
        const config = getProductConfig(productKey);
        credits = calcCredits(config, quantity);
        expectedAmount = toCents(config.unitAmountUsd) * quantity;
        productName = config.name;
    }


    if (!productKey || !purchaseFor || !userId) {
        console.error(`[PAYMENT] Missing required metadata:`, {
            productKey: !!productKey,
            purchaseFor: !!purchaseFor,
            userId: !!userId,
            metadata
        });
        console.log('[PAYMENT] Early return: Missing required metadata');
        return;
    }

    if (session.payment_status !== "paid") {
        // Not a successful payment, do not process further
        console.log('[PAYMENT] Early return: Payment status is not "paid", status:', session.payment_status);
        return;
    }

    console.log('[PAYMENT] ✅ Passed validation checks, proceeding with payment processing...');


    if (session.amount_total !== null && session.amount_total !== expectedAmount) {
        throw new Error("Amount mismatch for checkout session");
    }

    let userEmail: string | undefined = undefined;
    let userName: string | undefined = undefined;
    if (purchaseFor === "team") {
        if (!teamId) {
            throw new Error("Team ID missing in metadata");
        }

        const existing = await prisma.team_purchase.findFirst({
            where: { stripe_session_id: session.id },
        });

        if (existing?.status === "completed") {
            // Still send email if not sent before
            const user = await prisma.user.findUnique({ where: { id: userId } });
            userEmail = user?.email;
            userName = user?.name || undefined;
        } else {
            const operations: Prisma.PrismaPromise<any>[] = [];

            if (!existing) {
                operations.push(
                    prisma.team_purchase.create({
                        data: {
                            team_id: teamId,
                            amount: credits,
                            price_usd: (session.amount_total || 0) / 100,
                            status: "completed",
                            stripe_session_id: session.id,
                            completed_at: new Date(),
                        },
                    })
                );
            } else {
                operations.push(
                    prisma.team_purchase.update({
                        where: { id: existing.id },
                        data: { status: "completed", completed_at: new Date() },
                    })
                );
            }

            if (credits > 0) {
                operations.push(applyCreditsToTeam(teamId, credits));
            }

            await prisma.$transaction(operations);

            const user = await prisma.user.findUnique({ where: { id: userId } });
            userEmail = user?.email;
            userName = user?.name || undefined;
        }

        if (session.mode === "subscription") {
            const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
            const newSubscriptionId = typeof session.subscription === "string"
                ? session.subscription
                : session.subscription?.id;
            if (customerId && newSubscriptionId) {
                await cancelOtherActiveSubscriptions({
                    customerId,
                    purchaseFor,
                    teamId,
                    userId,
                    keepSubscriptionId: newSubscriptionId,
                });
            }
        }
    } else if (credits > 0) {
        const packageRecord = await ensureCreditPackage({
            name: `plan_${productKey}`,
            credits,
            price: (session.amount_total || 0) / 100,
        });

        const existing = await prisma.user_credit_purchase.findFirst({
            where: { stripe_session_id: session.id },
        });

        if (existing?.status === "completed") {
            // Still send email if not sent before
            const user = await prisma.user.findUnique({ where: { id: userId } });
            userEmail = user?.email;
            userName = user?.name || undefined;
        } else {
            const demoTransferCredits = await getOneTimeDemoTransferCredits({
                userId,
                productKey,
                purchaseFor,
            });
            const operations: Prisma.PrismaPromise<any>[] = [];

            if (!existing) {
                // Calculate next renewal date (1 month from now)
                // const nextRenewalDate = new Date();
                // nextRenewalDate.setMonth(nextRenewalDate.getMonth() + 1);

                const nextRenewalDate = new Date();
                nextRenewalDate.setMinutes(nextRenewalDate.getMinutes() + 1);

                operations.push(
                    prisma.user_credit_purchase.create({
                        data: {
                            user_id: userId,
                            package_id: packageRecord.id,
                            amount: credits,
                            price_usd: (session.amount_total || 0) / 100,
                            status: "completed",
                            stripe_session_id: session.id,
                            completed_at: new Date(),
                            autoRenewEnabled: true,
                            nextRenewalDate: nextRenewalDate,
                            renewalCount: 0,
                        },
                    })
                );
            } else {
                // Calculate next renewal date (1 month from now)
                // const nextRenewalDate = new Date();
                // nextRenewalDate.setMonth(nextRenewalDate.getMonth() + 1);

                const nextRenewalDate = new Date();
                nextRenewalDate.setMinutes(nextRenewalDate.getMinutes() + 1);
                
                operations.push(
                    prisma.user_credit_purchase.update({
                        where: { id: existing.id },
                        data: {
                            status: "completed",
                            completed_at: new Date(),
                            autoRenewEnabled: true,
                            nextRenewalDate: nextRenewalDate,
                        },
                    })
                );
            }

            operations.push(applyCreditsToUser(userId, credits + demoTransferCredits));

            if (demoTransferCredits > 0) {
                operations.push(
                    prisma.user_demo_tracking.upsert({
                        where: { user_id: userId },
                        create: {
                            user_id: userId,
                            uploads_count: DEMO_LIMIT,
                            last_reset_at: new Date(),
                        },
                        update: {
                            uploads_count: DEMO_LIMIT,
                            last_reset_at: new Date(),
                        },
                    })
                );
            }

            await prisma.$transaction(operations);

            const completedPurchase = await prisma.user_credit_purchase.findFirst({
                where: {
                    stripe_session_id: session.id,
                    user_id: userId,
                    status: "completed",
                },
                orderBy: { created_at: "desc" },
            });

            if (session.mode === "subscription" && completedPurchase) {
                await enforceSingleActiveAutoRenewalSubscription({
                    userId,
                    keepPurchaseId: completedPurchase.id,
                });
            }

            const user = await prisma.user.findUnique({ where: { id: userId } });
            userEmail = user?.email;
            userName = user?.name || undefined;
        }

        if (session.mode === "subscription") {
            const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
            const newSubscriptionId = typeof session.subscription === "string"
                ? session.subscription
                : session.subscription?.id;
            if (customerId && newSubscriptionId) {
                await cancelOtherActiveSubscriptions({
                    customerId,
                    purchaseFor,
                    userId,
                    keepSubscriptionId: newSubscriptionId,
                });
            }
        }
    } else {
        const existingPayment = await prisma.payment.findFirst({
            where: { stripe_session_id: session.id },
        });

        if (existingPayment?.status === "PAID") {
            const user = await prisma.user.findUnique({ where: { id: userId } });
            userEmail = user?.email;
            userName = user?.name || undefined;
        } else if (!existingPayment) {
            await prisma.payment.create({
                data: {
                    user_id: userId,
                    amount: (session.amount_total || 0) / 100,
                    currency: "usd",
                    status: "PAID",
                    stripe_session_id: session.id,
                },
            });
            const user = await prisma.user.findUnique({ where: { id: userId } });
            userEmail = user?.email;
            userName = user?.name || undefined;
        } else {
            await prisma.payment.update({
                where: { id: existingPayment.id },
                data: { status: "PAID" },
            });
            const user = await prisma.user.findUnique({ where: { id: userId } });
            userEmail = user?.email;
            userName = user?.name || undefined;
        }
    }

    // Send receipt email after successful payment processing
    if (userEmail) {
        let emailSent = false;
        let emailError: string | undefined = undefined;
        let emailSentAt: Date | undefined = undefined;

        console.log('[PAYMENT] ===== ENTERING EMAIL SECTION =====');
        console.log('[PAYMENT] userEmail:', userEmail);
        console.log('[PAYMENT] credits:', credits);
        console.log('[PAYMENT] sessionId:', session.id);

        try {
            console.log(`[EMAIL-DEBUG] User and email found, preparing to send receipt to ${userEmail}`);
            await sendEmail({
                from: "hello@elevatespacesai.com",
                senderName: "Elevated Spaces",
                to: userEmail,
                subject: "Your Payment Receipt - Elevated Spaces",
                text: `Thank you for your payment!\n\nProduct: ${productName}\nCredits: ${credits}\nAmount Paid: $${((session.amount_total || 0) / 100).toFixed(2)}\n\nIf you have any questions, contact support@elevatespacesai.com.`,
                html: `<h2>Thank you for your payment!</h2><p><b>Product:</b> ${productName}<br/><b>Credits:</b> ${credits}<br/><b>Amount Paid:</b> $${((session.amount_total || 0) / 100).toFixed(2)}</p><p>If you have any questions, contact <a href='mailto:support@elevatespacesai.com'>support@elevatespacesai.com</a>.</p>`,
            });
            console.log(`[EMAIL-DEBUG] Payment receipt sent to ${userEmail} successfully.`);
            emailSent = true;
            emailSentAt = new Date();
        } catch (emailErr) {
            console.error('[EMAIL-DEBUG] sendEmail threw error:', emailErr);
            emailError = emailErr instanceof Error ? emailErr.message : String(emailErr);
        }

        // Log payment to MongoDB
        try {
            console.log('[PAYMENT] Logging payment to MongoDB for session:', session.id);
            await loggingService.logPayment({
                transactionId: session.id,
                userId,
                userEmail,
                teamId,
                amount: (session.amount_total || 0) / 100,
                currency: session.currency || 'usd',
                credits,
                status: 'completed',
                paymentMethod: session.payment_method_types?.[0] || 'unknown',
                provider: 'stripe',
                providerResponse: {
                    sessionId: session.id,
                    customer: session.customer,
                    subscription: session.subscription,
                    mode: session.mode,
                },
                emailSent,
                emailSentAt,
                emailError,
                metadata: {
                    productKey,
                    productName,
                    purchaseFor,
                    quantity,
                },
            });
            console.log('[PAYMENT] Payment logged successfully to MongoDB');
        } catch (logErr) {
            console.error('[PAYMENT] Error logging payment to MongoDB:', logErr);
        }
    } else {
        console.error('[EMAIL-DEBUG] No user email found for receipt. userId:', userId);

        // Log payment even without email
        try {
            console.log('[PAYMENT] Logging payment to MongoDB (no email) for session:', session.id);
            await loggingService.logPayment({
                transactionId: session.id,
                userId,
                teamId,
                amount: (session.amount_total || 0) / 100,
                currency: session.currency || 'usd',
                credits,
                status: 'completed',
                paymentMethod: session.payment_method_types?.[0] || 'unknown',
                provider: 'stripe',
                emailSent: false,
                emailError: 'No user email found',
                metadata: {
                    productKey,
                    productName,
                    purchaseFor,
                    quantity,
                },
            });
            console.log('[PAYMENT] Payment logged successfully to MongoDB (no email)');
        } catch (logErr) {
            console.error('[PAYMENT] Error logging payment to MongoDB:', logErr);
        }
    }
}

export async function handleInvoicePaid(invoice: Stripe.Invoice) {
    const rawSubscription = (invoice as any).subscription as string | { id: string } | null;
    const subscriptionId = typeof rawSubscription === "string" ? rawSubscription : rawSubscription?.id;
    if (!subscriptionId) {
        return;
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const metadata = subscription.metadata || {};
    const productKey = metadata.productKey;
    const purchaseFor = metadata.purchaseFor as PurchaseFor | undefined;
    const userId = metadata.userId;
    const teamId = metadata.teamId;
    const quantity = Number(metadata.quantity || 1);

    if (!productKey || !purchaseFor || !userId) {
        return;
    }

    const config = getProductConfig(productKey);
    const credits = calcCredits(config, quantity);
    const expectedAmount = toCents(config.unitAmountUsd) * quantity;

    if (invoice.amount_paid !== expectedAmount) {
        throw new Error("Amount mismatch for invoice");
    }

    if (purchaseFor === "team") {
        if (!teamId) {
            throw new Error("Team ID missing in metadata");
        }

        const existing = await prisma.team_purchase.findFirst({
            where: { stripe_invoice_id: invoice.id },
        });

        if (existing) {
            return;
        }

        const operations: Prisma.PrismaPromise<any>[] = [
            prisma.team_purchase.create({
                data: {
                    team_id: teamId,
                    amount: credits,
                    price_usd: invoice.amount_paid / 100,
                    status: "completed",
                    stripe_invoice_id: invoice.id,
                    completed_at: new Date(),
                },
            }),
        ];

        if (credits > 0) {
            operations.push(applyCreditsToTeam(teamId, credits));
        }

        await prisma.$transaction(operations);

        // Get user email for logging
        const user = await prisma.user.findUnique({ where: { id: userId } });

        // Log subscription renewal payment to MongoDB
        try {
            console.log('[PAYMENT] Logging subscription renewal (team) to MongoDB for invoice:', invoice.id);
            await loggingService.logPayment({
                transactionId: invoice.id,
                userId,
                userEmail: user?.email,
                teamId,
                amount: invoice.amount_paid / 100,
                currency: invoice.currency || 'usd',
                credits,
                status: 'completed',
                paymentMethod: 'subscription',
                provider: 'stripe',
                providerResponse: {
                    invoiceId: invoice.id,
                    subscriptionId,
                    customer: invoice.customer,
                    hostedInvoiceUrl: invoice.hosted_invoice_url,
                },
                emailSent: false,
                metadata: {
                    productKey,
                    productName: config.name,
                    purchaseFor,
                    quantity,
                    billingReason: invoice.billing_reason,
                },
            });
            console.log('[PAYMENT] Subscription renewal (team) logged successfully to MongoDB');
        } catch (logErr) {
            console.error('[PAYMENT] Error logging subscription renewal (team) to MongoDB:', logErr);
        }

        return;
    }

    if (credits > 0) {
        const packageRecord = await ensureCreditPackage({
            name: `plan_${productKey}`,
            credits,
            price: invoice.amount_paid / 100,
        });

        const existing = await prisma.user_credit_purchase.findFirst({
            where: { stripe_invoice_id: invoice.id },
        });

        if (existing) {
            return;
        }

        await prisma.$transaction([
            prisma.user_credit_purchase.create({
                data: {
                    user_id: userId,
                    package_id: packageRecord.id,
                    amount: credits,
                    price_usd: invoice.amount_paid / 100,
                    status: "completed",
                    stripe_invoice_id: invoice.id,
                    completed_at: new Date(),
                },
            }),
            applyCreditsToUser(userId, credits),
        ]);

        // Get user email for logging
        const user = await prisma.user.findUnique({ where: { id: userId } });

        // Log subscription renewal payment to MongoDB
        try {
            console.log('[PAYMENT] Logging subscription renewal (personal) to MongoDB for invoice:', invoice.id);
            await loggingService.logPayment({
                transactionId: invoice.id,
                userId,
                userEmail: user?.email,
                amount: invoice.amount_paid / 100,
                currency: invoice.currency || 'usd',
                credits,
                status: 'completed',
                paymentMethod: 'subscription',
                provider: 'stripe',
                providerResponse: {
                    invoiceId: invoice.id,
                    subscriptionId,
                    customer: invoice.customer,
                    hostedInvoiceUrl: invoice.hosted_invoice_url,
                },
                emailSent: false,
                metadata: {
                    productKey,
                    productName: config.name,
                    purchaseFor,
                    quantity,
                    billingReason: invoice.billing_reason,
                },
            });
            console.log('[PAYMENT] Subscription renewal (personal) logged successfully to MongoDB');
        } catch (logErr) {
            console.error('[PAYMENT] Error logging subscription renewal (personal) to MongoDB:', logErr);
        }

        return;
    }
}

export async function getSessionDetails(sessionId: string) {
    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: ["line_items.data.price.product"],
        });

        const metadata = session.metadata || {};
        const rawProductKey = metadata.productKey || "";
        const normalizedProductKey = rawProductKey.toLowerCase().trim().replace(/[\s-]+/g, "_");

        const lineItems = (session as any).line_items?.data as Array<any> | undefined;
        const firstLineItem = lineItems?.[0];
        const resolvedProductName =
            metadata.productName ||
            firstLineItem?.description ||
            ((firstLineItem?.price?.product as any)?.name as string | undefined) ||
            null;

        const metadataCategory = metadata.productCategory || metadata.productType || "";
        const normalizedCategory = String(metadataCategory).toLowerCase();
        const isAddonFromName =
            typeof resolvedProductName === "string" &&
            (resolvedProductName.toLowerCase().includes("furnishing") || resolvedProductName.toLowerCase().includes("physical staging"));
        const resolvedProductCategory =
            normalizedCategory === "addon" ||
                normalizedProductKey === "furnishing_addon" ||
                isAddonFromName
                ? "addon"
                : normalizedCategory || null;

        return {
            id: session.id,
            status: session.status,
            payment_status: session.payment_status,
            customer_email: session.customer_details?.email,
            amount_total: session.amount_total,
            currency: session.currency,
            subscription: session.subscription,
            mode: session.mode,
            metadata,
            resolvedProductKey: normalizedProductKey || null,
            resolvedProductName,
            resolvedProductCategory,
        };
    } catch (error: any) {
        throw new Error(`Failed to retrieve session: ${error.message}`);
    }
}

export function constructStripeEvent(rawBody: Buffer, signature: string) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
        throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
    }

    return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

export async function processPendingPurchases() {
    console.log("[PENDING-PROCESSOR] Starting pending purchase processing");

    try {
        // Find all pending user credit purchases
        const pendingPurchases = await prisma.user_credit_purchase.findMany({
            where: { status: "pending" },
            take: 50,
            include: {
                package: {
                    select: {
                        name: true,
                    },
                },
            },
        });

        console.log(`[PENDING-PROCESSOR] Found ${pendingPurchases.length} pending purchases`);

        for (const purchase of pendingPurchases) {
            try {
                if (!purchase.stripe_session_id) {
                    console.log(`[PENDING-PROCESSOR] Skipping purchase ${purchase.id} - no session ID`);
                    continue;
                }

                // Fetch session from Stripe
                const session = await stripe.checkout.sessions.retrieve(purchase.stripe_session_id);

                console.log(`[PENDING-PROCESSOR] Checking session ${session.id}:`, {
                    paymentStatus: session.payment_status,
                    userId: purchase.user_id
                });

                if (session.payment_status === "paid") {
                    const metadata = session.metadata || {};
                    const rawProductKey = metadata.productKey || "";
                    const normalizedProductKey = String(rawProductKey)
                        .toLowerCase()
                        .trim()
                        .replace(/[\s-]+/g, "_");
                    const purchaseFor = (metadata.purchaseFor as PurchaseFor | undefined) || "individual";
                    const isSubscriptionPlan =
                        session.mode === "subscription" ||
                        PLAN_PRODUCT_KEYS.has(normalizedProductKey as any) ||
                        SUBSCRIPTION_PLAN_PACKAGE_NAMES.includes(purchase.package?.name || "");
                    const nextRenewalDate = new Date();
                    nextRenewalDate.setMinutes(nextRenewalDate.getMinutes() + 1);

                    const demoTransferCredits = await getOneTimeDemoTransferCredits({
                        userId: purchase.user_id,
                        productKey: normalizedProductKey,
                        purchaseFor,
                    });

                    const operations: Prisma.PrismaPromise<any>[] = [
                        prisma.user_credit_purchase.update({
                            where: { id: purchase.id },
                            data: {
                                status: "completed",
                                completed_at: new Date(),
                                autoRenewEnabled: isSubscriptionPlan,
                                nextRenewalDate: isSubscriptionPlan ? nextRenewalDate : null,
                                renewalCount: 0,
                            }
                        }),
                        applyCreditsToUser(purchase.user_id, purchase.amount + demoTransferCredits),
                    ];

                    if (demoTransferCredits > 0) {
                        operations.push(
                            prisma.user_demo_tracking.upsert({
                                where: { user_id: purchase.user_id },
                                create: {
                                    user_id: purchase.user_id,
                                    uploads_count: DEMO_LIMIT,
                                    last_reset_at: new Date(),
                                },
                                update: {
                                    uploads_count: DEMO_LIMIT,
                                    last_reset_at: new Date(),
                                },
                            })
                        );
                    }

                    await prisma.$transaction(operations);

                    if (isSubscriptionPlan) {
                        await enforceSingleActiveAutoRenewalSubscription({
                            userId: purchase.user_id,
                            keepPurchaseId: purchase.id,
                        });
                    }

                    console.log(`[PENDING-PROCESSOR] ✓ Processed purchase ${purchase.id}:`, {
                        userId: purchase.user_id,
                        sessionMode: session.mode,
                        productKey: rawProductKey,
                        normalizedProductKey,
                        isSubscriptionPlan,
                        credits: purchase.amount,
                        transferredDemoCredits: demoTransferCredits,
                    });
                }
            } catch (error: any) {
                console.error(`[PENDING-PROCESSOR] Error processing purchase ${purchase.id}:`, error.message);
            }
        }

        console.log("[PENDING-PROCESSOR] Completed pending purchase processing");
    } catch (error: any) {
        if (isDatabaseUnavailableError(error)) {
            console.warn(
                "[PENDING-PROCESSOR] Database unreachable (P1001). Skipping this cycle and retrying on next schedule."
            );
            return;
        }

        console.error("[PENDING-PROCESSOR] Error:", error.message || error);
    }
}
