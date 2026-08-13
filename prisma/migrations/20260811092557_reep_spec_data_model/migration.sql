-- The spec's data model, in one migration: the five-bucket time sheet, the
-- skill catalogue and its claims, VTU results, the SWOC board, mock
-- assessments, the login-day streak, the jobs feed and its weekly import, the
-- two-step leave workflow, pre-approval registration, and the mail log.
--
-- Two columns added to existing tables needed hand-written backfills, because
-- both are NOT NULL and both tables already had rows. They are the only edits
-- to what Prisma generated; each is annotated where it appears below.

-- CreateEnum
CREATE TYPE "DayActivity" AS ENUM ('SLEEPING', 'LEISURE', 'LECTURES', 'COURSEWORK', 'SKILLING');

-- CreateEnum
CREATE TYPE "SwocSource" AS ENUM ('PLACEMENT', 'MENTOR', 'PM');

-- CreateEnum
CREATE TYPE "SwocKind" AS ENUM ('STRENGTH', 'WEAKNESS', 'OPPORTUNITY', 'CHALLENGE');

-- CreateEnum
CREATE TYPE "MockType" AS ENUM ('GD', 'INTERVIEW', 'APTITUDE');

-- CreateEnum
CREATE TYPE "DegreeLevel" AS ENUM ('UG', 'PG');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('SUBMITTED', 'FIRST_APPROVED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeaveDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('DRAFT', 'PENDING_VERIFICATION', 'PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MailStatus" AS ENUM ('SENT', 'FAILED', 'SUPPRESSED');

-- AlterTable
-- Hand-edited. Prisma generated a single `ADD COLUMN … NOT NULL`, which cannot
-- run against a table that already has three cohorts in it. The column carries
-- no default in the schema on purpose — a cohort's degree level is an
-- admissions fact and guessing it silently shows a UG batch MBA-only vacancies
-- — so the value is supplied once, here, for the rows that predate it. Every
-- cohort in the programme at the time this ran was postgraduate.
ALTER TABLE "cohorts" ADD COLUMN     "degreeLevel" "DegreeLevel";
UPDATE "cohorts" SET "degreeLevel" = 'PG' WHERE "degreeLevel" IS NULL;
ALTER TABLE "cohorts" ALTER COLUMN "degreeLevel" SET NOT NULL;

-- AlterTable
ALTER TABLE "mentor_notes" ADD COLUMN     "meetingAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Hand-edited, and the same reasoning as `lab_sessions.createdAt` before it:
-- the column default stamps every existing note with the moment the migration
-- ran, which would move a conversation held in July onto the day of the deploy
-- and put it at the top of every timeline. The notes that exist were written in
-- the room, so the meeting is dated from when the note was.
UPDATE "mentor_notes" SET "meetingAt" = "createdAt";

-- AlterTable
ALTER TABLE "mentors" ADD COLUMN     "firstApproverUserId" TEXT;

-- AlterTable
ALTER TABLE "resumes" ADD COLUMN     "jobId" TEXT;

-- AlterTable
ALTER TABLE "student_profiles" ADD COLUMN     "leaderboardOptOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "photoUploadId" TEXT;

-- CreateTable
CREATE TABLE "time_sheet_entries" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "activity" "DayActivity" NOT NULL,
    "minutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_sheet_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "aliases" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_skills" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 3,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "evidenceUploadId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_claims" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "claimedLevel" INTEGER NOT NULL DEFAULT 3,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semester_results" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "semester" INTEGER NOT NULL,
    "sgpa" DOUBLE PRECISION,
    "cgpa" DOUBLE PRECISION,
    "resultClass" TEXT,
    "publishedOn" TIMESTAMP(3),

    CONSTRAINT "semester_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_marks" (
    "id" TEXT NOT NULL,
    "semesterResultId" TEXT NOT NULL,
    "subjectCode" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 4,
    "internal" INTEGER NOT NULL DEFAULT 0,
    "external" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "passed" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "subject_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swoc_entries" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "source" "SwocSource" NOT NULL,
    "kind" "SwocKind" NOT NULL,
    "text" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 3,
    "authorUserId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "swoc_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_attempts" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "type" "MockType" NOT NULL,
    "takenOn" TIMESTAMP(3) NOT NULL,
    "score" DOUBLE PRECISION,
    "maxScore" DOUBLE PRECISION,
    "evaluatorUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mock_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_days" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,

    CONSTRAINT "login_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "sourceRef" TEXT,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "degreeLevel" "DegreeLevel" NOT NULL,
    "location" TEXT,
    "applyUrl" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "requiredSkills" TEXT[],
    "postedOn" TIMESTAMP(3) NOT NULL,
    "closesOn" TIMESTAMP(3),
    "importRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_applications" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "selfReported" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,

    CONSTRAINT "job_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_import_runs" (
    "id" TEXT NOT NULL,
    "fileName" TEXT,
    "uploadedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "rowsSeen" INTEGER NOT NULL DEFAULT 0,
    "rowsCreated" INTEGER NOT NULL DEFAULT 0,
    "rowsUpdated" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "job_import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'SUBMITTED',
    "firstApproverUserId" TEXT,
    "firstDecision" "LeaveDecision",
    "firstDecidedAt" TIMESTAMP(3),
    "firstNote" TEXT,
    "secondApproverUserId" TEXT,
    "secondDecision" "LeaveDecision",
    "secondDecidedAt" TIMESTAMP(3),
    "secondNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "usn" TEXT,
    "phone" TEXT,
    "degreeLevel" "DegreeLevel" NOT NULL DEFAULT 'PG',
    "cohortId" TEXT,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'DRAFT',
    "matchedRuleId" TEXT,
    "decisionReason" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "approvedStudentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "emailDomain" TEXT,
    "usnPattern" TEXT,
    "degreeLevel" "DegreeLevel",
    "cohortId" TEXT,
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verifications" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_logs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "subject" TEXT,
    "status" "MailStatus" NOT NULL DEFAULT 'SENT',
    "error" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "time_sheet_entries_studentId_day_idx" ON "time_sheet_entries"("studentId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "time_sheet_entries_studentId_day_activity_key" ON "time_sheet_entries"("studentId", "day", "activity");

-- CreateIndex
CREATE UNIQUE INDEX "skills_slug_key" ON "skills"("slug");

-- CreateIndex
CREATE INDEX "skills_category_idx" ON "skills"("category");

-- CreateIndex
CREATE INDEX "student_skills_skillId_idx" ON "student_skills"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "student_skills_studentId_skillId_key" ON "student_skills"("studentId", "skillId");

-- CreateIndex
CREATE INDEX "skill_claims_studentId_status_idx" ON "skill_claims"("studentId", "status");

-- CreateIndex
CREATE INDEX "skill_claims_status_idx" ON "skill_claims"("status");

-- CreateIndex
CREATE INDEX "skill_claims_skillId_idx" ON "skill_claims"("skillId");

-- CreateIndex
CREATE INDEX "semester_results_studentId_idx" ON "semester_results"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "semester_results_studentId_semester_key" ON "semester_results"("studentId", "semester");

-- CreateIndex
CREATE UNIQUE INDEX "subject_marks_semesterResultId_subjectCode_key" ON "subject_marks"("semesterResultId", "subjectCode");

-- CreateIndex
CREATE INDEX "swoc_entries_studentId_kind_idx" ON "swoc_entries"("studentId", "kind");

-- CreateIndex
CREATE INDEX "swoc_entries_studentId_source_idx" ON "swoc_entries"("studentId", "source");

-- CreateIndex
CREATE INDEX "mock_attempts_studentId_takenOn_idx" ON "mock_attempts"("studentId", "takenOn");

-- CreateIndex
CREATE INDEX "mock_attempts_type_takenOn_idx" ON "mock_attempts"("type", "takenOn");

-- CreateIndex
CREATE INDEX "login_days_day_idx" ON "login_days"("day");

-- CreateIndex
CREATE UNIQUE INDEX "login_days_userId_day_key" ON "login_days"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_sourceRef_key" ON "jobs"("sourceRef");

-- CreateIndex
CREATE INDEX "jobs_degreeLevel_postedOn_idx" ON "jobs"("degreeLevel", "postedOn");

-- CreateIndex
CREATE INDEX "jobs_closesOn_idx" ON "jobs"("closesOn");

-- CreateIndex
CREATE INDEX "job_applications_jobId_idx" ON "job_applications"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "job_applications_studentId_jobId_key" ON "job_applications"("studentId", "jobId");

-- CreateIndex
CREATE INDEX "job_import_runs_startedAt_idx" ON "job_import_runs"("startedAt");

-- CreateIndex
CREATE INDEX "leave_requests_status_createdAt_idx" ON "leave_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "leave_requests_requesterUserId_createdAt_idx" ON "leave_requests"("requesterUserId", "createdAt");

-- CreateIndex
CREATE INDEX "leave_requests_firstApproverUserId_status_idx" ON "leave_requests"("firstApproverUserId", "status");

-- CreateIndex
CREATE INDEX "leave_requests_secondApproverUserId_status_idx" ON "leave_requests"("secondApproverUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_email_key" ON "registrations"("email");

-- CreateIndex
CREATE INDEX "registrations_status_createdAt_idx" ON "registrations"("status", "createdAt");

-- CreateIndex
CREATE INDEX "registration_rules_enabled_priority_idx" ON "registration_rules"("enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "email_verifications_tokenHash_key" ON "email_verifications"("tokenHash");

-- CreateIndex
CREATE INDEX "email_verifications_registrationId_idx" ON "email_verifications"("registrationId");

-- CreateIndex
CREATE UNIQUE INDEX "mail_logs_dedupeKey_key" ON "mail_logs"("dedupeKey");

-- CreateIndex
CREATE INDEX "mail_logs_kind_sentAt_idx" ON "mail_logs"("kind", "sentAt");

-- CreateIndex
CREATE INDEX "mail_logs_recipient_sentAt_idx" ON "mail_logs"("recipient", "sentAt");

-- CreateIndex
CREATE INDEX "mentor_notes_studentId_meetingAt_idx" ON "mentor_notes"("studentId", "meetingAt");

-- AddForeignKey
ALTER TABLE "mentors" ADD CONSTRAINT "mentors_firstApproverUserId_fkey" FOREIGN KEY ("firstApproverUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_photoUploadId_fkey" FOREIGN KEY ("photoUploadId") REFERENCES "uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_sheet_entries" ADD CONSTRAINT "time_sheet_entries_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_skills" ADD CONSTRAINT "student_skills_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_skills" ADD CONSTRAINT "student_skills_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_skills" ADD CONSTRAINT "student_skills_evidenceUploadId_fkey" FOREIGN KEY ("evidenceUploadId") REFERENCES "uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_claims" ADD CONSTRAINT "skill_claims_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_claims" ADD CONSTRAINT "skill_claims_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_claims" ADD CONSTRAINT "skill_claims_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semester_results" ADD CONSTRAINT "semester_results_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_marks" ADD CONSTRAINT "subject_marks_semesterResultId_fkey" FOREIGN KEY ("semesterResultId") REFERENCES "semester_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swoc_entries" ADD CONSTRAINT "swoc_entries_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swoc_entries" ADD CONSTRAINT "swoc_entries_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_attempts" ADD CONSTRAINT "mock_attempts_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_attempts" ADD CONSTRAINT "mock_attempts_evaluatorUserId_fkey" FOREIGN KEY ("evaluatorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_days" ADD CONSTRAINT "login_days_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_importRunId_fkey" FOREIGN KEY ("importRunId") REFERENCES "job_import_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_requesterUserId_fkey" FOREIGN KEY ("requesterUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_firstApproverUserId_fkey" FOREIGN KEY ("firstApproverUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_secondApproverUserId_fkey" FOREIGN KEY ("secondApproverUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "cohorts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_matchedRuleId_fkey" FOREIGN KEY ("matchedRuleId") REFERENCES "registration_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_rules" ADD CONSTRAINT "registration_rules_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "cohorts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
