import { Request, Response } from "express";
import { constructStripeEvent, createCheckoutSession, handleCheckoutCompleted, handleInvoicePaid, getSessionDetails, processPendingPurchases } from "../services/payment.service";
import Stripe from "stripe";
import prisma from "../dbConnection";
import { loggingService } from "../services/logging.service";

export async function createCheckoutSessionHandler(req: Request, res: Response) {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        const { productKey, purchaseFor, teamId, quantity, confirmPlanChange } = req.body;
        if (!productKey || !purchaseFor) {
            return res.status(400).json({ message: "Product key and purchase type are required" });
        }

        const result = await createCheckoutSession({
            userId,
            productKey,
            purchaseFor,
            teamId,
            quantity,
            confirmPlanChange,
        });

        return res.status(200).json(result);
    } catch (error: any) {
        if (error?.code === "PLAN_CHANGE_CONFIRMATION_REQUIRED") {
            return res.status(409).json({
                message: error.message || "Plan change confirmation required",
                code: error.code,
            });
        }
        return res.status(400).json({
            message: error.message || "Failed to create checkout session",
            ...(error?.code ? { code: error.code } : {}),
        });
    }
}

export async function getCreditsHandler(req: Request, res: Response) {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        // Get user's personal credit balance
        const creditBalance = await prisma.user_credit_balance.findUnique({
            where: { user_id: userId }
        });

        // Get user's purchase history
        const purchases = await prisma.user_credit_purchase.findMany({
            where: { user_id: userId },
            include: { package: true },
            orderBy: { completed_at: 'desc' },
            take: 10
        });

        return res.status(200).json({
            success: true,
            data: {
                currentBalance: creditBalance?.balance || 0,
                recentPurchases: purchases.map(p => ({
                    amount: p.amount,
                    price: p.price_usd,
                    status: p.status,
                    completedAt: p.completed_at,
                    packageName: p.package?.name
                }))
            }
        });
    } catch (error: any) {
        return res.status(400).json({ message: error.message || "Failed to retrieve credits" });
    }
}

export async function getWebhookLogsHandler(req: Request, res: Response) {
    try {
        const { limit = 20 } = req.query;
        const maxLimit = Math.min(Number(limit), 100);

        // Get recent webhook events
        const events = await prisma.webhook_event.findMany({
            orderBy: { created_at: 'desc' },
            take: maxLimit
        });

        return res.status(200).json({
            success: true,
            data: {
                totalEvents: events.length,
                events: events.map((e: any) => ({
                    eventId: e.event_id,
                    eventType: e.event_type,
                    processed: e.processed,
                    errorMessage: e.error_message,
                    createdAt: e.created_at,
                    data: e.data ? JSON.parse(e.data) : null
                }))
            }
        });
    } catch (error: any) {
        return res.status(400).json({ message: error.message || "Failed to retrieve webhook logs" });
    }
}

export async function getSessionDetailsHandler(req: Request, res: Response) {
    try {
        const { sessionId } = req.params;
        if (!sessionId) {
            return res.status(400).json({ message: "Session ID is required" });
        }

        // Note: We don't strictly require authentication here because:
        // 1. Stripe session IDs are difficult to guess (they're cryptographically secure)
        // 2. The payment has already been processed and validated by Stripe
        // 3. The session ID is passed via URL after redirect from Stripe
        // 4. Users need to access this even if their token expired
        
        const sessionDetails = await getSessionDetails(sessionId);

        return res.status(200).json(sessionDetails);
    } catch (error: any) {
        return res.status(400).json({ message: error.message || "Failed to retrieve session details" });
    }
}

export async function stripeWebhookHandler(req: Request, res: Response) {
    try {
        const signature = req.headers["stripe-signature"] as string;
        if (!signature) {
            console.error("Missing stripe-signature header");
            return res.status(400).json({ message: "Missing stripe-signature header" });
        }

        const event = constructStripeEvent(req.body as Buffer, signature);
        console.log(`[WEBHOOK] Received Stripe event: ${event.type}`, {
            eventId: event.id,
            timestamp: new Date(event.created * 1000).toISOString(),
        });

        // Store webhook event for debugging
        await prisma.webhook_event.create({
            data: {
                event_type: event.type,
                event_id: event.id,
                data: JSON.stringify(event.data),
                processed: false,
                error_message: null
            }
        }).catch((err: unknown) => console.log("Failed to store webhook event:", err));

        switch (event.type) {
            case "checkout.session.completed": {
                const session = event.data.object as Stripe.Checkout.Session;
                console.log(`[WEBHOOK] Processing checkout.session.completed:`, {
                    sessionId: session.id,
                    customerId: session.customer,
                    paymentStatus: session.payment_status,
                    metadata: session.metadata
                });
                try {
                    await handleCheckoutCompleted(session);
                    console.log(`[WEBHOOK] Successfully processed checkout.session.completed`);
                    
                    // Mark webhook as processed
                    await prisma.webhook_event.update({
                        where: { event_id: event.id },
                        data: { processed: true }
                    }).catch(() => {});
                } catch (error: unknown) {
                    const err = error as any;
                    console.error(`[WEBHOOK] Error processing checkout.session.completed:`, err);
                    await prisma.webhook_event.update({
                        where: { event_id: event.id },
                        data: { error_message: err.message }
                    }).catch(() => {});
                    throw err;
                }
                break;
            }
            case "invoice.paid": {
                const invoice = event.data.object as Stripe.Invoice;
                console.log(`[WEBHOOK] Processing invoice.paid:`, {
                    invoiceId: invoice.id,
                    customerId: invoice.customer,
                    amountPaid: invoice.amount_paid
                });
                try {
                    await handleInvoicePaid(invoice);
                    console.log(`[WEBHOOK] Successfully processed invoice.paid`);
                    
                    // Mark webhook as processed
                    await prisma.webhook_event.update({
                        where: { event_id: event.id },
                        data: { processed: true }
                    }).catch(() => {});
                } catch (error: unknown) {
                    const err = error as any;
                    console.error(`[WEBHOOK] Error processing invoice.paid:`, err);
                    await prisma.webhook_event.update({
                        where: { event_id: event.id },
                        data: { error_message: err.message }
                    }).catch(() => {});
                    throw err;
                }
                break;
            }
            default:
                console.log(`[WEBHOOK] Ignoring event type: ${event.type}`);
        }

        return res.status(200).json({ received: true });
    } catch (error: any) {
        console.error("Stripe webhook error:", error.message || error);
        return res.status(400).json({ message: "Webhook error" });
    }
}
export async function simulateWebhookHandler(req: Request, res: Response) {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.status(400).json({ message: "sessionId is required" });
        }

        // Fetch the actual session from Stripe
        const sessionDetails = await getSessionDetails(sessionId);
        const stripeSession = sessionDetails as unknown as Stripe.Checkout.Session;

        console.log(`[SIMULATE-WEBHOOK] Processing session:`, {
            sessionId,
            paymentStatus: stripeSession.payment_status,
            amountTotal: stripeSession.amount_total,
            metadata: stripeSession.metadata
        });

        // Call handleCheckoutCompleted directly
        if (stripeSession.payment_status === "paid") {
            await handleCheckoutCompleted(stripeSession as Stripe.Checkout.Session);
            console.log(`[SIMULATE-WEBHOOK] Successfully simulated webhook for session:`, sessionId);
            return res.status(200).json({
                success: true,
                message: "Webhook simulation processed",
                processed: true
            });
        } else {
            return res.status(400).json({
                success: false,
                message: `Session payment status is ${stripeSession.payment_status}, expected 'paid'`
            });
        }
    } catch (error: any) {
        console.error("[SIMULATE-WEBHOOK] Error:", error.message || error);
        return res.status(400).json({
            success: false,
            message: error.message || "Failed to simulate webhook"
        });
    }
}

export async function processPendingPurchasesHandler(req: Request, res: Response) {
    try {
        // This endpoint can be called manually to retry pending purchases
        // In production, this should be protected or only available internally
        await processPendingPurchases();
        
        return res.status(200).json({
            success: true,
            message: "Pending purchase processing completed"
        });
    } catch (error: any) {
        console.error("Error processing pending purchases:", error);
        return res.status(400).json({
            success: false,
            message: error.message || "Failed to process pending purchases"
        });
    }
}

export async function testPaymentLogHandler(req: Request, res: Response) {
    try {
        console.log('[TEST-PAYMENT-LOG] Testing payment logging to MongoDB...');
        
        const testPaymentData = {
            transactionId: `test_${Date.now()}`,
            userId: req.user?.id || 'test-user-123',
            userEmail: req.user?.email || 'test@example.com',
            amount: 99.99,
            currency: 'usd',
            credits: 100,
            status: 'completed' as const,
            paymentMethod: 'test',
            provider: 'stripe',
            emailSent: true,
            metadata: {
                productKey: 'test-product',
                productName: 'Test Product',
                purchaseFor: 'individual',
                test: true
            }
        };
        
        console.log('[TEST-PAYMENT-LOG] Attempting to log:', testPaymentData);
        await loggingService.logPayment(testPaymentData);
        console.log('[TEST-PAYMENT-LOG] ✅ Payment logged successfully');
        
        return res.status(200).json({
            success: true,
            message: "Test payment logged to MongoDB successfully",
            data: testPaymentData
        });
    } catch (error: any) {
        console.error('[TEST-PAYMENT-LOG] ❌ Error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to log test payment",
            error: error.toString()
        });
    }
}