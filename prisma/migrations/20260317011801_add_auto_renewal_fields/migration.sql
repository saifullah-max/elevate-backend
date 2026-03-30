-- AlterTable
ALTER TABLE "user_credit_purchase" ADD COLUMN     "auto_renew_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "cancellation_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "next_renewal_date" TIMESTAMP(3),
ADD COLUMN     "renewal_count" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "user_credit_purchase_auto_renew_enabled_next_renewal_date_idx" ON "user_credit_purchase"("auto_renew_enabled", "next_renewal_date");
