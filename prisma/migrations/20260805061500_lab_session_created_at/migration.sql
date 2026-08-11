-- AlterTable
ALTER TABLE "lab_sessions" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Rows that already exist were, so far as anything here knows, written as they
-- happened. Leaving them stamped with the migration time would mark every
-- historical session as backfilled the moment this column arrives, so date them
-- from the session itself instead.
UPDATE "lab_sessions" SET "createdAt" = COALESCE("checkOutAt", "checkInAt");
