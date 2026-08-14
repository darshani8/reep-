-- CreateEnum
CREATE TYPE "OfferRoleType" AS ENUM ('FULL_TIME', 'FULL_TIME_PLUS_INTERNSHIP', 'INTERNSHIP');

-- CreateEnum
CREATE TYPE "OfferChannel" AS ENUM ('ON_CAMPUS', 'OFF_CAMPUS', 'POOL', 'REFERRAL');

-- CreateEnum
CREATE TYPE "OfferWorkMode" AS ENUM ('REMOTE', 'ONSITE', 'HYBRID');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "QualificationLevel" AS ENUM ('TENTH', 'TWELFTH', 'DIPLOMA', 'UNDERGRAD', 'POSTGRAD');

-- AlterTable
ALTER TABLE "placement_criteria" ADD COLUMN     "maxGapMonths" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "maxLiveBacklogs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "minCgpa" DOUBLE PRECISION NOT NULL DEFAULT 6.0;

-- AlterTable
ALTER TABLE "semester_results" ADD COLUMN     "closedBacklogs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "liveBacklogs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "marksheetUploadId" TEXT;

-- AlterTable
ALTER TABLE "student_profiles" ADD COLUMN     "interestedInInternships" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "interestedInJobs" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "placementEligible" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "placement_offers" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "jobId" TEXT,
    "roleType" "OfferRoleType" NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "organisation" TEXT NOT NULL,
    "channel" "OfferChannel" NOT NULL DEFAULT 'ON_CAMPUS',
    "joiningDate" TIMESTAMP(3),
    "workMode" "OfferWorkMode" NOT NULL DEFAULT 'ONSITE',
    "location" TEXT,
    "ctcInr" INTEGER NOT NULL DEFAULT 0,
    "fixedGrossInr" INTEGER NOT NULL DEFAULT 0,
    "bonuses" JSONB NOT NULL DEFAULT '[]',
    "offerLetterUploadId" TEXT,
    "loiUploadId" TEXT,
    "jobDescription" TEXT,
    "bondDetails" TEXT,
    "otherBenefits" TEXT,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "placement_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_qualifications" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "level" "QualificationLevel" NOT NULL,
    "institution" TEXT NOT NULL,
    "board" TEXT,
    "year" INTEGER NOT NULL,
    "marks" DOUBLE PRECISION NOT NULL,
    "maxMarks" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "medium" TEXT,
    "location" TEXT,
    "subjects" TEXT,

    CONSTRAINT "academic_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_gaps" (
    "studentId" TEXT NOT NULL,
    "twelfthToGradMo" INTEGER NOT NULL DEFAULT 0,
    "diplomaToGradMo" INTEGER NOT NULL DEFAULT 0,
    "gradToPgMo" INTEGER NOT NULL DEFAULT 0,
    "otherMo" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "academic_gaps_pkey" PRIMARY KEY ("studentId")
);

-- CreateIndex
CREATE INDEX "placement_offers_studentId_status_idx" ON "placement_offers"("studentId", "status");

-- CreateIndex
CREATE INDEX "academic_qualifications_studentId_level_idx" ON "academic_qualifications"("studentId", "level");

-- AddForeignKey
ALTER TABLE "placement_offers" ADD CONSTRAINT "placement_offers_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_offers" ADD CONSTRAINT "placement_offers_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_offers" ADD CONSTRAINT "placement_offers_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_qualifications" ADD CONSTRAINT "academic_qualifications_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_gaps" ADD CONSTRAINT "academic_gaps_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
