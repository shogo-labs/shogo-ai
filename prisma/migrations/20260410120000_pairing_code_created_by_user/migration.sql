-- AlterTable: add createdByUserId to pairing_codes
ALTER TABLE "pairing_codes" ADD COLUMN "createdByUserId" TEXT;

-- AddForeignKey
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
