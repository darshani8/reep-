-- The assistant's audit table reached the development database through
-- `prisma db push` and never got a migration of its own, so every subsequent
-- `prisma migrate dev` reported drift and offered to reset. This file is that
-- missing migration, written from the diff between the migration history and
-- the live schema, and marked as already applied with
-- `prisma migrate resolve --applied` on the database that had it. A fresh
-- database now builds `agent_runs` here rather than never at all.

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('ANSWERED', 'EXHAUSTED', 'REFUSED', 'FAILED');

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "scope" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL DEFAULT '',
    "status" "AgentRunStatus" NOT NULL,
    "trace" JSONB NOT NULL,
    "citations" JSONB NOT NULL,
    "model" TEXT,
    "steps" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_runs_actorId_createdAt_idx" ON "agent_runs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_runs_status_idx" ON "agent_runs"("status");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
