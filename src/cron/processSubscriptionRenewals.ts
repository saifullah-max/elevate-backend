import SubscriptionRenewalService from "../services/subscription-renewal.service";

/**
 * Scheduled cron job to process subscription renewals
 * Runs daily to check for subscriptions that are due for renewal (nextRenewalDate <= now)
 */
export async function processSubscriptionRenewals() {
    const jobName = "processSubscriptionRenewals";
    
    try {
        console.log(`[${jobName}] Starting subscription renewal processing...`);
        
        const result = await SubscriptionRenewalService.processPendingRenewals();
        
        console.log(
            `[${jobName}] Completion Report: ${result.processed} processed, ${result.successful} successful, ${result.failed} failed`
        );
        
        return result;
    } catch (error) {
        console.error(
            `[${jobName}] Critical error during renewal processing:`,
            error
        );
        throw error;
    }
}

export default processSubscriptionRenewals;
