import prisma from "../dbConnection";
import { sendEmail } from "../config/mail.config";

export interface InvoiceData {
    invoiceId: string;
    subscriptionId: string;
    userId: string;
    packageName: string;
    credits: number;
    amount: number;
    currency: string;
    issueDate: Date;
    dueDate: Date;
    renewalNumber: number;
    userName: string;
    userEmail: string;
    companyName: string;
}

/**
 * Invoice Generation Service
 * Handles creation and delivery of PDF invoices
 */
export class InvoiceService {
    /**
     * Generate invoice HTML (for browser preview or PDF conversion)
     */
    static generateInvoiceHTML(data: InvoiceData): string {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; }
                    .container { max-width: 900px; margin: 0 auto; padding: 40px 20px; }
                    .header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 40px; border-bottom: 2px solid #007bff; padding-bottom: 20px; }
                    .company-info h1 { font-size: 24px; color: #007bff; margin-bottom: 5px; }
                    .invoice-info { text-align: right; }
                    .invoice-info h2 { font-size: 28px; color: #333; margin-bottom: 10px; }
                    .invoice-info p { font-size: 12px; color: #666; line-height: 1.6; }
                    .customer-section { margin: 40px 0; }
                    .section-title { font-size: 12px; font-weight: bold; color: #007bff; text-transform: uppercase; margin-bottom: 8px; }
                    .customer-info { font-size: 13px; line-height: 1.6; color: #555; }
                    .items-table { width: 100%; margin: 30px 0; border-collapse: collapse; }
                    .items-table th { background-color: #f5f5f5; padding: 12px 10px; text-align: left; font-size: 12px; font-weight: 600; color: #333; border-bottom: 2px solid #007bff; }
                    .items-table td { padding: 12px 10px; font-size: 13px; border-bottom: 1px solid #ddd; }
                    .items-table tr:hover { background-color: #f9f9f9; }
                    .text-right { text-align: right; }
                    .summary { margin: 30px 0; display: flex; justify-content: flex-end; }
                    .summary-box { width: 300px; }
                    .summary-row { display: flex; justify-content: space-between; padding: 8px 0; font-size: 13px; border-bottom: 1px solid #ddd; }
                    .summary-row.total { font-weight: bold; font-size: 16px; border-bottom: 2px solid #007bff; color: #007bff; padding: 12px 0; }
                    .footer { margin-top: 50px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 11px; color: #999; text-align: center; line-height: 1.6; }
                    .badge { display: inline-block; background-color: #28a745; color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
                    .renewal-badge { background-color: #17a2b8; }
                </style>
            </head>
            <body>
                <div class="container">
                    <!-- Header -->
                    <div class="header">
                        <div class="company-info">
                            <h1>${data.companyName}</h1>
                            <p style="font-size: 12px; color: #666;">Virtual Staging & Credit Platform</p>
                        </div>
                        <div class="invoice-info">
                            <h2>INVOICE</h2>
                            <p><strong>Invoice #:</strong> ${data.invoiceId}</p>
                            <p><strong>Renewal #:</strong> ${data.renewalNumber}</p>
                            <p><strong>Issue Date:</strong> ${data.issueDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                            <p><strong>Due Date:</strong> ${data.dueDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                            <p style="margin-top: 8px;"><span class="badge renewal-badge">AUTO-RENEWAL</span></p>
                        </div>
                    </div>

                    <!-- Bill To -->
                    <div class="customer-section">
                        <div class="section-title">Bill To</div>
                        <div class="customer-info">
                            <p><strong>${data.userName}</strong></p>
                            <p>${data.userEmail}</p>
                        </div>
                    </div>

                    <!-- Items Table -->
                    <table class="items-table">
                        <thead>
                            <tr>
                                <th style="width: 50%;">Description</th>
                                <th style="width: 20%;">Quantity</th>
                                <th style="width: 15%;" class="text-right">Unit Price</th>
                                <th style="width: 15%;" class="text-right">Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>
                                    <strong>${data.packageName} Plan - Monthly Subscription</strong><br>
                                    <span style="font-size: 12px; color: #666;">${data.credits} Credits</span>
                                </td>
                                <td>1</td>
                                <td class="text-right">$${data.amount.toFixed(2)}</td>
                                <td class="text-right"><strong>$${data.amount.toFixed(2)}</strong></td>
                            </tr>
                        </tbody>
                    </table>

                    <!-- Summary -->
                    <div class="summary">
                        <div class="summary-box">
                            <div class="summary-row">
                                <span>Subtotal:</span>
                                <span>$${data.amount.toFixed(2)}</span>
                            </div>
                            <div class="summary-row">
                                <span>Tax:</span>
                                <span>$0.00</span>
                            </div>
                            <div class="summary-row total">
                                <span>Total Due:</span>
                                <span>$${data.amount.toFixed(2)}</span>
                            </div>
                        </div>
                    </div>

                    <!-- Footer -->
                    <div class="footer">
                        <p><strong>Thank you for your business!</strong></p>
                        <p>This invoice is for a recurring monthly subscription. Your payment has been processed.</p>
                        <p style="margin-top: 10px; font-size: 10px;">Next billing date: ${new Date(data.dueDate.getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                        <p style="margin-top: 15px; color: #666;"><strong>${data.companyName}</strong> © 2026. All rights reserved.</p>
                    </div>
                </div>
            </body>
            </html>
        `;
    }

    /**
     * Create invoice record in database
     */
    static async createInvoice(data: {
        subscriptionId: string;
        userId: string;
        amount: number;
        status: "generated" | "sent" | "paid";
        htmlContent: string;
        metadata?: Record<string, any>;
    }) {
        try {
            const invoice = await prisma.$executeRawUnsafe(`
                INSERT INTO "invoice" 
                (id, "subscription_id", "user_id", amount, status, "html_content", metadata, "created_at", "updated_at")
                VALUES 
                ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
                RETURNING *
            `, 
            `INV-${Date.now()}`,
            data.subscriptionId,
            data.userId,
            data.amount,
            data.status,
            data.htmlContent,
            JSON.stringify(data.metadata || {})
            );

            return invoice;
        } catch (error) {
            console.error("Error creating invoice record:", error);
            throw error;
        }
    }

    /**
     * Send invoice via email
     */
    static async sendInvoiceEmail(
        to: string,
        userName: string,
        packageName: string,
        invoiceHtml: string,
        amount: number
    ) {
        try {
            await sendEmail({
                from: "noreply@elevatedspaces.com",
                senderName: "Elevated Spaces",
                to,
                subject: `Invoice Confirmation - ${packageName} Subscription Renewal`,
                text: `Your ${packageName} subscription renewal invoice for $${amount.toFixed(2)} is attached. Thank you for your business!`,
                html: `
                    <h2>Invoice Confirmation</h2>
                    <p>Hi ${userName},</p>
                    <p>Your ${packageName} subscription renewal has been processed successfully.</p>
                    <p>Invoice amount: <strong>$${amount.toFixed(2)}</strong></p>
                    <p>Please see the attached invoice for details. Your next billing cycle will renew on the same date next month.</p>
                    <br>
                    <p>Thank you for continuing with Elevated Spaces!</p>
                    <hr>
                    <p style="font-size: 12px; color: #666;">
                        <strong>${packageName} Plan Details:</strong><br>
                        Amount: $${amount.toFixed(2)}<br>
                        Billing: Monthly recurring<br>
                        Status: Active
                    </p>
                `,
            });

            console.log(`Invoice email sent to ${to}`);
        } catch (error) {
            console.error("Error sending invoice email:", error);
            throw error;
        }
    }

    /**
     * Get invoice HTML for display (for preview on frontend)
     */
    static async getInvoicePreview(invoiceId: string) {
        try {
            // This would fetch from DB in production
            // For now, return null for testing
            return null;
        } catch (error) {
            console.error("Error getting invoice preview:", error);
            throw error;
        }
    }

    /**
     * Get user's invoice history
     */
    static async getUserInvoices(userId: string, limit = 10) {
        try {
            const invoices = await prisma.$executeRawUnsafe(`
                SELECT 
                    inv.id,
                    inv."subscription_id",
                    inv.amount,
                    inv.status,
                    inv."created_at",
                    ucp."package_id",
                    cp.name as "package_name",
                    cp.credits
                FROM invoice inv
                JOIN "user_credit_purchase" ucp ON inv."subscription_id" = ucp.id
                JOIN "credit_package" cp ON ucp."package_id" = cp.id
                WHERE inv."user_id" = $1
                ORDER BY inv."created_at" DESC
                LIMIT $2
            `, userId, limit);

            return invoices || [];
        } catch (error) {
            console.error("Error fetching user invoices:", error);
            throw error;
        }
    }
}

export default InvoiceService;
