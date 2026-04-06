import prisma from '../src/dbConnection';

/**
 * Migration script: Set nextRenewalDate for all existing subscriptions
 * that don't have one set (from before the renewal feature was added)
 */
async function fixRenewalDates() {
  try {
    console.log('[FIX-RENEWAL-DATES] Starting migration...');

    // Count subscriptions without nextRenewalDate
    const needsUpdate = await prisma.user_credit_purchase.count({
      where: {
        nextRenewalDate: null,
      },
    });

    console.log(`[FIX-RENEWAL-DATES] Found ${needsUpdate} subscriptions without renewal dates`);

    if (needsUpdate === 0) {
      console.log('[FIX-RENEWAL-DATES] ✅ All subscriptions already have renewal dates set');
      return;
    }

    // Set nextRenewalDate to now + 1 minute for all subscriptions missing it
    const nextRenewalDate = new Date();
    nextRenewalDate.setMinutes(nextRenewalDate.getMinutes() + 1);

    const result = await prisma.user_credit_purchase.updateMany({
      where: {
        nextRenewalDate: null,
      },
      data: {
        nextRenewalDate: nextRenewalDate,
      },
    });

    console.log(`[FIX-RENEWAL-DATES] ✅ Updated ${result.count} subscriptions`);
    console.log(`[FIX-RENEWAL-DATES] Next renewal date set to: ${nextRenewalDate.toISOString()}`);

    // Show sample of updated records
    const samples = await prisma.user_credit_purchase.findMany({
      where: {
        nextRenewalDate: nextRenewalDate,
      },
      take: 5,
      select: {
        id: true,
        user_id: true,
        status: true,
        autoRenewEnabled: true,
        nextRenewalDate: true,
        renewalCount: true,
      },
    });

    console.log('[FIX-RENEWAL-DATES] Sample updated records:');
    console.table(samples);

    console.log('[FIX-RENEWAL-DATES] ✅ Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('[FIX-RENEWAL-DATES] ❌ Migration failed:', error);
    process.exit(1);
  }
}

fixRenewalDates();
