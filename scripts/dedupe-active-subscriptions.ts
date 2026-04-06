import prisma from "../src/dbConnection";

async function run() {
  const active = await prisma.user_credit_purchase.findMany({
    where: {
      status: "completed",
      autoRenewEnabled: true,
      cancelledAt: null,
    },
    orderBy: [{ user_id: "asc" }, { created_at: "desc" }],
    select: {
      id: true,
      user_id: true,
      created_at: true,
      nextRenewalDate: true,
    },
  });

  const keepByUser = new Set<string>();
  const toDisable: string[] = [];

  for (const row of active) {
    if (keepByUser.has(row.user_id)) {
      toDisable.push(row.id);
      continue;
    }
    keepByUser.add(row.user_id);
  }

  if (toDisable.length === 0) {
    console.log("[DEDUPE] No duplicate active subscriptions found.");
    return;
  }

  const result = await prisma.user_credit_purchase.updateMany({
    where: { id: { in: toDisable } },
    data: {
      autoRenewEnabled: false,
      nextRenewalDate: null,
      cancelledAt: new Date(),
      cancellationReason: "Deduped: replaced by newer active subscription",
    },
  });

  console.log(`[DEDUPE] Disabled ${result.count} duplicate active subscriptions.`);
}

run()
  .catch((err) => {
    console.error("[DEDUPE] Failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
