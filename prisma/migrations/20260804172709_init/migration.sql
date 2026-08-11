-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'MENTOR', 'DIRECTOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('REBOOT', 'EXCEL', 'EXCEL_ADVANCED', 'ELEVATE');

-- CreateEnum
CREATE TYPE "Dimension" AS ENUM ('PROFESSIONAL', 'THINKING', 'TECHNICAL', 'METAPHYSICAL');

-- CreateEnum
CREATE TYPE "CourseModel" AS ENUM ('TEACHING_PLUS_SELF_LEARN', 'SUPERVISED_SELF_LEARN', 'INSTRUCTOR_LED');

-- CreateEnum
CREATE TYPE "LearningMode" AS ENUM ('INSTRUCTOR_LED', 'SUPERVISED_LAB', 'INDEPENDENT');

-- CreateEnum
CREATE TYPE "ProgressStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "PaceStatus" AS ENUM ('ON_TRACK', 'BEHIND', 'AT_RISK');

-- CreateEnum
CREATE TYPE "CheckInSource" AS ENUM ('BADGE', 'LAB_PC', 'MANUAL', 'SELF_REPORTED');

-- CreateEnum
CREATE TYPE "AlertRuleKey" AS ENUM ('NO_CHECKIN_N_DAYS', 'PACE_BELOW_THRESHOLD', 'ATTENDANCE_BELOW_THRESHOLD', 'CERT_OVERDUE', 'LOW_FOCUS_QUALITY');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "MentorAction" AS ENUM ('NONE', 'FLAGGED', 'NUDGE_SENT', 'ONE_ON_ONE_SCHEDULED');

-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('LAB_SESSION', 'LECTURE', 'CERT_DEADLINE', 'MENTOR_MEETING');

-- CreateEnum
CREATE TYPE "ResumeStatus" AS ENUM ('DRAFT', 'GENERATED', 'FINALISED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "avatarInitials" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cohorts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "batchLabel" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentors" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Prof.',
    "department" TEXT NOT NULL DEFAULT 'MBA',
    "mentorGroup" TEXT NOT NULL,

    CONSTRAINT "mentors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "usn" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "mentorId" TEXT,
    "currentStage" "Stage" NOT NULL DEFAULT 'EXCEL',
    "currentSemester" INTEGER NOT NULL DEFAULT 1,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "weeklyHourTarget" DOUBLE PRECISION NOT NULL DEFAULT 12,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stage" "Stage" NOT NULL,
    "dimension" "Dimension" NOT NULL,
    "semester" INTEGER NOT NULL,
    "teachingHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "selfLearningHoursRequired" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "modelType" "CourseModel" NOT NULL,
    "durationWeeks" INTEGER NOT NULL DEFAULT 16,
    "description" TEXT,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "certifications" (
    "code" TEXT NOT NULL,
    "courseCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'Coursera',
    "requiredHours" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "link" TEXT,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "dueWeek" INTEGER NOT NULL DEFAULT 12,

    CONSTRAINT "certifications_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "courseCode" TEXT NOT NULL,
    "status" "ProgressStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "teachingHoursAttended" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "selfLearningHoursLogged" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lecturesAttended" INTEGER NOT NULL DEFAULT 0,
    "lecturesTotal" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification_progress" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "certCode" TEXT NOT NULL,
    "status" "ProgressStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "progressPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hoursLogged" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "selfReported" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "certification_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_sessions" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "courseCode" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "mode" "LearningMode" NOT NULL DEFAULT 'SUPERVISED_LAB',
    "source" "CheckInSource" NOT NULL DEFAULT 'LAB_PC',
    "checkInAt" TIMESTAMP(3) NOT NULL,
    "checkOutAt" TIMESTAMP(3),
    "durationMin" INTEGER,
    "progressAtCheckIn" DOUBLE PRECISION,
    "progressAtCheckOut" DOUBLE PRECISION,
    "progressDeltaPct" DOUBLE PRECISION,
    "mentorConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "lab_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "courseCode" TEXT NOT NULL,
    "sessionDate" TIMESTAMP(3) NOT NULL,
    "sessionNo" INTEGER NOT NULL,
    "present" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentor_notes" (
    "id" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "noteText" TEXT NOT NULL,
    "linkedAction" "MentorAction" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentor_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "ruleTriggered" "AlertRuleKey" NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',
    "message" TEXT NOT NULL,
    "context" JSONB,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rule_configs" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "ruleKey" "AlertRuleKey" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "params" JSONB NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',

    CONSTRAINT "alert_rule_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_items" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "courseCode" TEXT,
    "type" "ScheduleType" NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,

    CONSTRAINT "schedule_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "placement_criteria" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "minReepCompletionPct" DOUBLE PRECISION NOT NULL DEFAULT 80,
    "requireCoreCerts" BOOLEAN NOT NULL DEFAULT true,
    "minAttendancePct" DOUBLE PRECISION NOT NULL DEFAULT 85,
    "minCertCompletionPct" DOUBLE PRECISION NOT NULL DEFAULT 75,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "placement_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profiles" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "linkedinUrl" TEXT,
    "githubUrl" TEXT,
    "portfolioUrl" TEXT,
    "city" TEXT,
    "careerSummary" TEXT,
    "education" JSONB NOT NULL DEFAULT '[]',
    "experience" JSONB NOT NULL DEFAULT '[]',
    "projects" JSONB NOT NULL DEFAULT '[]',
    "skills" JSONB NOT NULL DEFAULT '[]',
    "achievements" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resumes" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL DEFAULT 'REEP Resume',
    "targetRole" TEXT,
    "targetIndustry" TEXT,
    "jobDescription" TEXT,
    "status" "ResumeStatus" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL,
    "markdown" TEXT NOT NULL DEFAULT '',
    "evidence" JSONB,
    "scoring" JSONB,
    "model" TEXT,
    "generatedBy" TEXT NOT NULL DEFAULT 'fallback',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resumes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "cohorts_code_key" ON "cohorts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "mentors_userId_key" ON "mentors"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "students_userId_key" ON "students"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "students_usn_key" ON "students"("usn");

-- CreateIndex
CREATE INDEX "students_cohortId_idx" ON "students"("cohortId");

-- CreateIndex
CREATE INDEX "students_mentorId_idx" ON "students"("mentorId");

-- CreateIndex
CREATE INDEX "courses_stage_idx" ON "courses"("stage");

-- CreateIndex
CREATE INDEX "certifications_courseCode_idx" ON "certifications"("courseCode");

-- CreateIndex
CREATE INDEX "enrollments_courseCode_idx" ON "enrollments"("courseCode");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_studentId_courseCode_key" ON "enrollments"("studentId", "courseCode");

-- CreateIndex
CREATE INDEX "certification_progress_studentId_status_idx" ON "certification_progress"("studentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "certification_progress_studentId_certCode_key" ON "certification_progress"("studentId", "certCode");

-- CreateIndex
CREATE INDEX "lab_sessions_studentId_checkInAt_idx" ON "lab_sessions"("studentId", "checkInAt");

-- CreateIndex
CREATE INDEX "lab_sessions_courseCode_idx" ON "lab_sessions"("courseCode");

-- CreateIndex
CREATE INDEX "attendance_records_studentId_sessionDate_idx" ON "attendance_records"("studentId", "sessionDate");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_studentId_courseCode_sessionNo_key" ON "attendance_records"("studentId", "courseCode", "sessionNo");

-- CreateIndex
CREATE INDEX "mentor_notes_studentId_createdAt_idx" ON "mentor_notes"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "alerts_studentId_resolvedAt_idx" ON "alerts"("studentId", "resolvedAt");

-- CreateIndex
CREATE INDEX "alerts_ruleTriggered_idx" ON "alerts"("ruleTriggered");

-- CreateIndex
CREATE UNIQUE INDEX "alert_rule_configs_cohortId_ruleKey_key" ON "alert_rule_configs"("cohortId", "ruleKey");

-- CreateIndex
CREATE INDEX "schedule_items_studentId_startsAt_idx" ON "schedule_items"("studentId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_studentId_key" ON "student_profiles"("studentId");

-- CreateIndex
CREATE INDEX "resumes_studentId_createdAt_idx" ON "resumes"("studentId", "createdAt");

-- AddForeignKey
ALTER TABLE "mentors" ADD CONSTRAINT "mentors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "cohorts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "mentors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certifications" ADD CONSTRAINT "certifications_courseCode_fkey" FOREIGN KEY ("courseCode") REFERENCES "courses"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_courseCode_fkey" FOREIGN KEY ("courseCode") REFERENCES "courses"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certification_progress" ADD CONSTRAINT "certification_progress_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certification_progress" ADD CONSTRAINT "certification_progress_certCode_fkey" FOREIGN KEY ("certCode") REFERENCES "certifications"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_sessions" ADD CONSTRAINT "lab_sessions_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_sessions" ADD CONSTRAINT "lab_sessions_courseCode_fkey" FOREIGN KEY ("courseCode") REFERENCES "courses"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_courseCode_fkey" FOREIGN KEY ("courseCode") REFERENCES "courses"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentor_notes" ADD CONSTRAINT "mentor_notes_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "mentors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentor_notes" ADD CONSTRAINT "mentor_notes_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rule_configs" ADD CONSTRAINT "alert_rule_configs_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_courseCode_fkey" FOREIGN KEY ("courseCode") REFERENCES "courses"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
