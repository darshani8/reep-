-- CreateEnum
CREATE TYPE "UploadKind" AS ENUM ('CERTIFICATE_PROOF', 'RESUME', 'PROFILE_PHOTO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING_REVIEW', 'VERIFIED', 'REJECTED');

-- CreateTable
CREATE TABLE "uploads" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "kind" "UploadKind" NOT NULL,
    "certCode" TEXT,
    "title" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uploads_storedName_key" ON "uploads"("storedName");

-- CreateIndex
CREATE INDEX "uploads_studentId_kind_idx" ON "uploads"("studentId", "kind");

-- CreateIndex
CREATE INDEX "uploads_certCode_idx" ON "uploads"("certCode");

-- CreateIndex
CREATE INDEX "uploads_status_idx" ON "uploads"("status");

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_certCode_fkey" FOREIGN KEY ("certCode") REFERENCES "certifications"("code") ON DELETE SET NULL ON UPDATE CASCADE;
