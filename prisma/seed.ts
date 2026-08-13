/**
 * Seed the REEP dashboard with a coherent, deterministic dataset.
 *
 * Deterministic matters: the lab-session history drives every analytic in the
 * product, so a seeded PRNG means screenshots, demos and tests all agree. Run
 * `npm run db:seed` as many times as you like — it truncates first.
 *
 * The story it tells (today ≈ Aug 2026):
 *   - two junior cohorts partway through Excel · Semester 1
 *   - one senior cohort in Elevate, which is what gives the director screen
 *     real cross-cohort and bottleneck data
 *   - one undergraduate BBA cohort, so the UG/PG split has something on both
 *     sides of it — the jobs board and eligibility both key off degree level
 *   - Prof. Rakesh Iyer mentors MBA-2026-B, the twelve students from the
 *     wireframes, with Ananya on track and Aditi genuinely disengaging
 *   - Farhan Q. in the BBA cohort has used none of the newer features, which
 *     is the empty state every screen has to survive
 */

import {
  CheckInSource,
  CourseModel,
  type DayActivity,
  type DegreeLevel,
  Dimension,
  LearningMode,
  type MockType,
  PrismaClient,
  ProgressStatus,
  Role,
  Stage,
  type SwocKind,
  type SwocSource,
} from '@prisma/client';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const prisma = new PrismaClient();

// --- deterministic randomness ----------------------------------------------

function mulberry32(seed: number) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260804);
const between = (min: number, max: number) => min + rand() * (max - min);
const intBetween = (min: number, max: number) => Math.floor(between(min, max + 1));
const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)];

/** `n` distinct members, in a shuffled order. Fewer if the pool is smaller. */
function sample<T>(items: T[], n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}

/** UTC midnight, which is what a `@db.Date` column stores. */
const dateOnly = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// --- dates ------------------------------------------------------------------

const TODAY = new Date('2026-08-04T09:00:00Z');
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/** Excel · Semester 1 runs 1 Jun 2026 → 15 Oct 2026. Today is week 9 of 20. */
const TERM_START = new Date('2026-06-01T00:00:00Z');
const TERM_END = new Date('2026-10-15T00:00:00Z');

/** The senior cohort's Elevate term. */
const SENIOR_TERM_START = new Date('2026-06-01T00:00:00Z');

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

const PASSWORD = hashPassword('reep2026');

/**
 * A minimal, genuinely-PDF file for the seeded certificate uploads.
 *
 * `upload-sniff.ts` decides a file's type from its bytes rather than its
 * declared name, so a text file called `.pdf` would be rejected by the very
 * code the seed exists to exercise. These bytes open, say nothing, and are
 * three hundred bytes rather than a checked-in binary.
 */
const PLACEHOLDER_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
    '',
  ].join('\n'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Curriculum
// ---------------------------------------------------------------------------

type CourseSeed = {
  code: string;
  name: string;
  stage: Stage;
  dimension: Dimension;
  semester: number;
  teachingHours: number;
  selfLearningHoursRequired: number;
  modelType: CourseModel;
  durationWeeks: number;
  description: string;
  certs: { code: string; name: string; provider: string; hours: number; dueWeek: number; optional?: boolean }[];
  lectures?: number;
};

const COURSES: CourseSeed[] = [
  // --- Reboot (18-day pre-MBA bootcamp) ---
  {
    code: 'REE001',
    name: 'Success & Communication Foundations',
    stage: 'REBOOT',
    dimension: 'PROFESSIONAL',
    semester: 0,
    teachingHours: 10,
    selfLearningHoursRequired: 27,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 3,
    description: 'Sets the tone for the programme: personal effectiveness and speaking in public.',
    certs: [
      { code: 'C-REE001-SUCCESS', name: 'Success (Wharton)', provider: 'Coursera', hours: 15, dueWeek: 3 },
      { code: 'C-REE001-SPEAK', name: 'Introduction to Public Speaking', provider: 'Coursera', hours: 12, dueWeek: 3 },
    ],
  },
  {
    code: 'REE002',
    name: 'Quantitative Foundations',
    stage: 'REBOOT',
    dimension: 'THINKING',
    semester: 0,
    teachingHours: 12,
    selfLearningHoursRequired: 20,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 3,
    description: 'Rebuilds quantitative confidence ahead of Semester 1.',
    certs: [
      { code: 'C-REE002-MATH', name: 'Math for MBA and GMAT Prep', provider: 'Coursera', hours: 20, dueWeek: 4 },
    ],
  },
  {
    code: 'REE003',
    name: 'Digital Readiness',
    stage: 'REBOOT',
    dimension: 'TECHNICAL',
    semester: 0,
    teachingHours: 8,
    selfLearningHoursRequired: 14,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 3,
    description: 'Office productivity and campus digital tooling.',
    certs: [
      { code: 'C-REE003-OFFICE', name: 'Introduction to Computers and Office Productivity', provider: 'Coursera', hours: 14, dueWeek: 3 },
    ],
  },

  // --- Excel · Semester 1 ---
  {
    code: 'REE101',
    name: 'Principles of Professional Effectiveness',
    stage: 'EXCEL',
    dimension: 'PROFESSIONAL',
    semester: 1,
    teachingHours: 20,
    selfLearningHoursRequired: 69,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 20,
    description: 'Interpersonal skills, leadership and professional conduct.',
    certs: [
      { code: 'C-REE101-INTER', name: 'Developing Interpersonal Skills', provider: 'Coursera', hours: 18, dueWeek: 8 },
      { code: 'C-REE101-LEAD', name: 'Leadership Skills (IIM Ahmedabad)', provider: 'Coursera', hours: 25, dueWeek: 15 },
      { code: 'C-REE101-NEGO', name: 'Successful Negotiation', provider: 'Coursera', hours: 16, dueWeek: 19, optional: true },
    ],
  },
  {
    code: 'REE102',
    name: 'Thinking Skills - I',
    stage: 'EXCEL',
    dimension: 'THINKING',
    semester: 1,
    teachingHours: 8,
    selfLearningHoursRequired: 0,
    modelType: 'INSTRUCTOR_LED',
    durationWeeks: 20,
    description: 'Reading comprehension, guesstimates and structured problem solving.',
    lectures: 8,
    certs: [],
  },
  {
    code: 'REE103',
    name: 'Digital Productivity',
    stage: 'EXCEL',
    dimension: 'TECHNICAL',
    semester: 1,
    teachingHours: 7.5,
    selfLearningHoursRequired: 66,
    modelType: 'SUPERVISED_SELF_LEARN',
    durationWeeks: 20,
    description: 'Spreadsheet fluency for business analysis, taught mostly in supervised labs.',
    certs: [
      { code: 'C-REE103-XL-ESS', name: 'Excel Skills for Business: Essentials', provider: 'Coursera', hours: 20, dueWeek: 8 },
      { code: 'C-REE103-XL-INT1', name: 'Excel Skills for Business: Int. I', provider: 'Coursera', hours: 24, dueWeek: 14 },
      { code: 'C-REE103-XL-DATA', name: 'Excel Fundamentals for Data Analysis', provider: 'Coursera', hours: 22, dueWeek: 19 },
    ],
  },
  {
    code: 'REE104',
    name: 'Self & Society',
    stage: 'EXCEL',
    dimension: 'METAPHYSICAL',
    semester: 1,
    teachingHours: 10,
    selfLearningHoursRequired: 19,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 20,
    description: 'Well-being, ethics and reflective practice.',
    certs: [
      { code: 'C-REE104-WELL', name: 'The Science of Well-Being (Yale)', provider: 'Coursera', hours: 19, dueWeek: 14 },
    ],
  },

  // --- Excel · Semester 2 (senior cohort) ---
  {
    code: 'REE201',
    name: 'Business Communication',
    stage: 'EXCEL',
    dimension: 'PROFESSIONAL',
    semester: 2,
    teachingHours: 18,
    selfLearningHoursRequired: 40,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 18,
    description: 'Written and presented communication for business audiences.',
    certs: [
      { code: 'C-REE201-WRITE', name: 'Business Writing', provider: 'Coursera', hours: 18, dueWeek: 8 },
    ],
  },
  {
    code: 'REE202',
    name: 'Thinking Skills - II',
    stage: 'EXCEL',
    dimension: 'THINKING',
    semester: 2,
    teachingHours: 10,
    selfLearningHoursRequired: 0,
    modelType: 'INSTRUCTOR_LED',
    durationWeeks: 18,
    description: 'Advanced reasoning, case interviews and analytical writing.',
    lectures: 10,
    certs: [],
  },
  {
    code: 'REE203',
    name: 'Data Analysis & Visualization',
    stage: 'EXCEL',
    dimension: 'TECHNICAL',
    semester: 2,
    teachingHours: 12,
    selfLearningHoursRequired: 72,
    modelType: 'SUPERVISED_SELF_LEARN',
    durationWeeks: 18,
    description: 'The heaviest self-learning load in the programme — and its biggest bottleneck.',
    certs: [
      { code: 'C-REE203-PBI', name: 'Data Visualization with Power BI', provider: 'Coursera', hours: 30, dueWeek: 10 },
      { code: 'C-REE203-SQL', name: 'SQL for Data Science', provider: 'Coursera', hours: 28, dueWeek: 15 },
    ],
  },

  // --- Excel-Advanced (organizational study / internship) ---
  {
    code: 'REE301',
    name: 'Organizational Study / Internship',
    stage: 'EXCEL_ADVANCED',
    dimension: 'PROFESSIONAL',
    semester: 2,
    teachingHours: 6,
    selfLearningHoursRequired: 120,
    modelType: 'SUPERVISED_SELF_LEARN',
    durationWeeks: 6,
    description: 'A full month inside a host organisation, bridging Excel and Elevate.',
    certs: [
      { code: 'C-REE301-PM', name: 'Foundations of Project Management', provider: 'Coursera', hours: 22, dueWeek: 5 },
    ],
  },

  // --- Elevate ---
  {
    code: 'REE401',
    name: 'Placement Readiness',
    stage: 'ELEVATE',
    dimension: 'PROFESSIONAL',
    semester: 3,
    teachingHours: 24,
    selfLearningHoursRequired: 36,
    modelType: 'TEACHING_PLUS_SELF_LEARN',
    durationWeeks: 18,
    description: 'Resume, interview and assessment-centre preparation.',
    certs: [
      { code: 'C-REE401-INT', name: 'Advanced Interviewing Techniques', provider: 'Coursera', hours: 14, dueWeek: 8 },
    ],
  },
  {
    code: 'REE402',
    name: 'Specialisation Capstone',
    stage: 'ELEVATE',
    dimension: 'TECHNICAL',
    semester: 3,
    teachingHours: 16,
    selfLearningHoursRequired: 60,
    modelType: 'SUPERVISED_SELF_LEARN',
    durationWeeks: 18,
    description: 'An industry-sponsored capstone in the student’s chosen specialisation.',
    certs: [
      { code: 'C-REE402-STRAT', name: 'Business Strategy Capstone', provider: 'Coursera', hours: 26, dueWeek: 14 },
    ],
  },
];

const MODULES: Record<string, string[]> = {
  REE101: ['Interpersonal Skills — Module 1', 'Leadership Skills — Module 2', 'Feedback & Coaching'],
  REE102: ['Reading Comprehension', 'Guesstimate Practice'],
  REE103: [
    'Excel Fundamentals for Data Analysis',
    'Excel Skills for Business: Int. I',
    'PivotTables & Lookup Functions',
    'Charting for Business Reports',
  ],
  REE104: ['Science of Well-Being — Rewirement', 'Reflective Journal'],
  REE201: ['Business Writing — Structure', 'Presentation Craft'],
  REE203: ['Power BI — Data Modelling', 'SQL Joins & Aggregation', 'Dashboard Design'],
  REE301: ['Host Organisation Study', 'Project Management Foundations'],
  REE401: ['Mock Interview Clinic', 'Resume Workshop'],
  REE402: ['Capstone Research', 'Capstone Build'],
};

// ---------------------------------------------------------------------------
// Skill catalogue
// ---------------------------------------------------------------------------

/**
 * The vocabulary every skill, job and claim is expressed in.
 *
 * The aliases are not decoration. A job sheet says "MS Excel", a student types
 * "Advanced Excel" and a certificate is titled "Excel Skills for Business";
 * without them the jobs board computes a 0% match for everybody and looks
 * broken rather than empty. `JOBS` below deliberately draws its requirements
 * from these slugs for the same reason.
 */
type SkillSeed = { slug: string; name: string; category: string; aliases: string[] };

const SKILLS: SkillSeed[] = [
  // Spreadsheets & tools — the REEP Excel spine.
  { slug: 'excel', name: 'Microsoft Excel', category: 'Spreadsheets & Tools', aliases: ['ms excel', 'advanced excel', 'excel skills for business'] },
  { slug: 'pivot-tables', name: 'PivotTables', category: 'Spreadsheets & Tools', aliases: ['pivot table', 'pivots'] },
  { slug: 'lookup-functions', name: 'Lookup Functions', category: 'Spreadsheets & Tools', aliases: ['vlookup', 'xlookup', 'index match'] },
  { slug: 'excel-vba', name: 'Excel Macros & VBA', category: 'Spreadsheets & Tools', aliases: ['vba', 'macros'] },
  { slug: 'google-sheets', name: 'Google Sheets', category: 'Spreadsheets & Tools', aliases: ['gsheets', 'google spreadsheet'] },
  { slug: 'powerpoint', name: 'PowerPoint', category: 'Spreadsheets & Tools', aliases: ['ms powerpoint', 'slide design'] },
  { slug: 'ms-word', name: 'MS Word', category: 'Spreadsheets & Tools', aliases: ['microsoft word', 'word processing'] },

  // Data & analytics.
  { slug: 'power-bi', name: 'Power BI', category: 'Data & Analytics', aliases: ['powerbi', 'microsoft power bi'] },
  { slug: 'tableau', name: 'Tableau', category: 'Data & Analytics', aliases: ['tableau desktop'] },
  { slug: 'sql', name: 'SQL', category: 'Data & Analytics', aliases: ['mysql', 'postgresql', 'structured query language'] },
  { slug: 'statistics', name: 'Business Statistics', category: 'Data & Analytics', aliases: ['stats', 'statistical analysis'] },
  { slug: 'data-visualisation', name: 'Data Visualisation', category: 'Data & Analytics', aliases: ['data visualization', 'dataviz', 'charting'] },
  { slug: 'data-cleaning', name: 'Data Cleaning', category: 'Data & Analytics', aliases: ['data wrangling', 'data preparation'] },
  { slug: 'predictive-analytics', name: 'Predictive Analytics', category: 'Data & Analytics', aliases: ['forecasting models', 'ml basics'] },
  { slug: 'r-language', name: 'R', category: 'Data & Analytics', aliases: ['r studio', 'r programming'] },
  { slug: 'advanced-analytics', name: 'Advanced Analytics', category: 'Data & Analytics', aliases: ['analytics'] },

  // Technology.
  { slug: 'python', name: 'Python', category: 'Technology', aliases: ['python 3', 'python programming'] },
  { slug: 'sap', name: 'SAP', category: 'Technology', aliases: ['sap erp', 'sap mm', 'erp'] },
  { slug: 'canva', name: 'Canva', category: 'Technology', aliases: ['canva design'] },
  { slug: 'figma', name: 'Figma', category: 'Technology', aliases: ['ui design', 'figma prototyping'] },
  { slug: 'google-workspace', name: 'Google Workspace', category: 'Technology', aliases: ['g suite', 'google docs'] },
  { slug: 'power-automate', name: 'Power Automate', category: 'Technology', aliases: ['workflow automation'] },

  // Business & finance.
  { slug: 'financial-modelling', name: 'Financial Modelling', category: 'Business & Finance', aliases: ['financial modeling'] },
  { slug: 'financial-accounting', name: 'Financial Accounting', category: 'Business & Finance', aliases: ['accounting', 'bookkeeping'] },
  { slug: 'management-accounting', name: 'Management Accounting', category: 'Business & Finance', aliases: ['cost accounting'] },
  { slug: 'corporate-finance', name: 'Corporate Finance', category: 'Business & Finance', aliases: ['finance fundamentals'] },
  { slug: 'valuation', name: 'Valuation', category: 'Business & Finance', aliases: ['dcf', 'company valuation'] },
  { slug: 'equity-research', name: 'Equity Research', category: 'Business & Finance', aliases: ['stock research'] },
  { slug: 'budgeting', name: 'Budgeting & Forecasting', category: 'Business & Finance', aliases: ['budget planning'] },
  { slug: 'tally', name: 'Tally ERP', category: 'Business & Finance', aliases: ['tally erp 9', 'tally prime'] },
  { slug: 'gst-taxation', name: 'GST & Taxation', category: 'Business & Finance', aliases: ['gst', 'taxation', 'income tax'] },
  { slug: 'risk-management', name: 'Risk Management', category: 'Business & Finance', aliases: ['risk analysis'] },
  { slug: 'banking-operations', name: 'Banking Operations', category: 'Business & Finance', aliases: ['retail banking'] },
  { slug: 'product-management', name: 'Product Management', category: 'Business & Finance', aliases: ['product owner'] },
  { slug: 'business-analysis', name: 'Business Analysis', category: 'Business & Finance', aliases: ['requirements gathering', 'ba'] },

  // Marketing & sales.
  { slug: 'digital-marketing', name: 'Digital Marketing', category: 'Marketing & Sales', aliases: ['online marketing'] },
  { slug: 'seo', name: 'SEO', category: 'Marketing & Sales', aliases: ['search engine optimisation', 'search engine optimization'] },
  { slug: 'social-media-marketing', name: 'Social Media Marketing', category: 'Marketing & Sales', aliases: ['smm', 'social media'] },
  { slug: 'content-writing', name: 'Content Writing', category: 'Marketing & Sales', aliases: ['copywriting', 'content creation'] },
  { slug: 'market-research', name: 'Market Research', category: 'Marketing & Sales', aliases: ['consumer research', 'primary research'] },
  { slug: 'brand-management', name: 'Brand Management', category: 'Marketing & Sales', aliases: ['branding'] },
  { slug: 'crm', name: 'CRM', category: 'Marketing & Sales', aliases: ['salesforce', 'customer relationship management'] },
  { slug: 'sales-negotiation', name: 'Sales & Negotiation', category: 'Marketing & Sales', aliases: ['b2b sales', 'field sales'] },
  { slug: 'email-marketing', name: 'Email Marketing', category: 'Marketing & Sales', aliases: ['mailchimp'] },
  { slug: 'google-analytics', name: 'Google Analytics', category: 'Marketing & Sales', aliases: ['ga4', 'web analytics'] },

  // Operations & supply chain.
  { slug: 'supply-chain', name: 'Supply Chain Management', category: 'Operations & Supply Chain', aliases: ['scm', 'logistics'] },
  { slug: 'inventory-management', name: 'Inventory Management', category: 'Operations & Supply Chain', aliases: ['stock control'] },
  { slug: 'procurement', name: 'Procurement', category: 'Operations & Supply Chain', aliases: ['sourcing', 'purchasing'] },
  { slug: 'lean-six-sigma', name: 'Lean Six Sigma', category: 'Operations & Supply Chain', aliases: ['six sigma', 'lean'] },
  { slug: 'quality-management', name: 'Quality Management', category: 'Operations & Supply Chain', aliases: ['tqm', 'quality control'] },
  { slug: 'operations-research', name: 'Operations Research', category: 'Operations & Supply Chain', aliases: ['optimisation', 'linear programming'] },
  { slug: 'project-management', name: 'Project Management', category: 'Operations & Supply Chain', aliases: ['pmp', 'project planning'] },
  { slug: 'agile-scrum', name: 'Agile & Scrum', category: 'Operations & Supply Chain', aliases: ['scrum', 'agile'] },
  { slug: 'process-improvement', name: 'Process Improvement', category: 'Operations & Supply Chain', aliases: ['process mapping'] },

  // People & HR.
  { slug: 'recruitment', name: 'Recruitment', category: 'People & HR', aliases: ['talent acquisition', 'hiring'] },
  { slug: 'hr-analytics', name: 'HR Analytics', category: 'People & HR', aliases: ['people analytics'] },
  { slug: 'payroll', name: 'Payroll Management', category: 'People & HR', aliases: ['payroll processing'] },
  { slug: 'performance-management', name: 'Performance Management', category: 'People & HR', aliases: ['appraisals'] },
  { slug: 'learning-development', name: 'Learning & Development', category: 'People & HR', aliases: ['l&d', 'training'] },
  { slug: 'labour-law', name: 'Labour Law & Compliance', category: 'People & HR', aliases: ['industrial relations'] },
  { slug: 'employee-engagement', name: 'Employee Engagement', category: 'People & HR', aliases: ['engagement programmes'] },

  // Communication.
  { slug: 'business-writing', name: 'Business Writing', category: 'Communication', aliases: ['written communication', 'report writing'] },
  { slug: 'public-speaking', name: 'Public Speaking', category: 'Communication', aliases: ['presentation skills', 'oratory'] },
  { slug: 'presentation-design', name: 'Presentation Design', category: 'Communication', aliases: ['deck building', 'slide making'] },
  { slug: 'group-discussion', name: 'Group Discussion', category: 'Communication', aliases: ['gd', 'panel discussion'] },
  { slug: 'interview-skills', name: 'Interview Skills', category: 'Communication', aliases: ['interview preparation'] },
  { slug: 'client-communication', name: 'Client Communication', category: 'Communication', aliases: ['stakeholder communication'] },
  { slug: 'email-etiquette', name: 'Email Etiquette', category: 'Communication', aliases: ['professional email'] },
  { slug: 'data-storytelling', name: 'Storytelling with Data', category: 'Communication', aliases: ['data storytelling'] },

  // Leadership & teamwork.
  { slug: 'leadership', name: 'Leadership', category: 'Leadership & Teamwork', aliases: ['leading teams', 'team leadership'] },
  { slug: 'teamwork', name: 'Teamwork', category: 'Leadership & Teamwork', aliases: ['collaboration', 'team player'] },
  { slug: 'conflict-resolution', name: 'Conflict Resolution', category: 'Leadership & Teamwork', aliases: ['conflict management'] },
  { slug: 'negotiation', name: 'Negotiation', category: 'Leadership & Teamwork', aliases: ['successful negotiation', 'bargaining'] },
  { slug: 'delegation', name: 'Delegation', category: 'Leadership & Teamwork', aliases: ['task allocation'] },
  { slug: 'mentoring', name: 'Mentoring & Coaching', category: 'Leadership & Teamwork', aliases: ['coaching'] },
  { slug: 'emotional-intelligence', name: 'Emotional Intelligence', category: 'Leadership & Teamwork', aliases: ['eq', 'self awareness'] },

  // Thinking & problem solving.
  { slug: 'critical-thinking', name: 'Critical Thinking', category: 'Thinking & Problem Solving', aliases: ['analytical thinking'] },
  { slug: 'problem-solving', name: 'Structured Problem Solving', category: 'Thinking & Problem Solving', aliases: ['problem solving', 'issue trees'] },
  { slug: 'case-analysis', name: 'Case Analysis', category: 'Thinking & Problem Solving', aliases: ['case study', 'casing'] },
  { slug: 'guesstimation', name: 'Guesstimation', category: 'Thinking & Problem Solving', aliases: ['guesstimate', 'market sizing'] },
  { slug: 'quantitative-aptitude', name: 'Quantitative Aptitude', category: 'Thinking & Problem Solving', aliases: ['quant', 'aptitude'] },
  { slug: 'logical-reasoning', name: 'Logical Reasoning', category: 'Thinking & Problem Solving', aliases: ['reasoning', 'logical ability'] },
  { slug: 'decision-making', name: 'Decision Making', category: 'Thinking & Problem Solving', aliases: ['judgement'] },
  { slug: 'time-management', name: 'Time Management', category: 'Thinking & Problem Solving', aliases: ['prioritisation', 'productivity'] },
];

/// Everyone on the programme is taught these, so every student holds them.
/// They are also the two that appear most often across `JOBS`, which is what
/// keeps the weakest profile's match percentage off zero.
const UNIVERSAL_SKILLS = ['excel', 'business-writing'];

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

type JobSeed = {
  sourceRef: string;
  title: string;
  company: string;
  degreeLevel: DegreeLevel;
  location: string;
  requiredSkills: string[];
  /** Days before today the posting went up. */
  postedDaysAgo: number;
  /** Days after today it closes; negative for one that has already closed. */
  closesInDays: number;
};

const JOBS: JobSeed[] = [
  { sourceRef: 'REEP-2026-W31-001', title: 'Management Trainee — Finance', company: 'Infosys BPM', degreeLevel: 'PG', location: 'Bengaluru', requiredSkills: ['excel', 'financial-accounting', 'budgeting', 'business-writing'], postedDaysAgo: 6, closesInDays: 15 },
  { sourceRef: 'REEP-2026-W31-002', title: 'Business Analyst', company: 'Wipro', degreeLevel: 'PG', location: 'Bengaluru', requiredSkills: ['sql', 'power-bi', 'excel', 'problem-solving', 'business-analysis'], postedDaysAgo: 5, closesInDays: 21 },
  { sourceRef: 'REEP-2026-W31-003', title: 'Marketing Executive', company: 'Swiggy', degreeLevel: 'PG', location: 'Bengaluru', requiredSkills: ['digital-marketing', 'market-research', 'social-media-marketing', 'presentation-design'], postedDaysAgo: 4, closesInDays: 12 },
  { sourceRef: 'REEP-2026-W31-004', title: 'HR Generalist', company: 'Infosys', degreeLevel: 'PG', location: 'Mysuru', requiredSkills: ['recruitment', 'payroll', 'labour-law', 'employee-engagement', 'email-etiquette'], postedDaysAgo: 9, closesInDays: 9 },
  { sourceRef: 'REEP-2026-W31-005', title: 'Supply Chain Analyst', company: 'Flipkart', degreeLevel: 'PG', location: 'Bengaluru', requiredSkills: ['supply-chain', 'excel', 'inventory-management', 'statistics'], postedDaysAgo: 7, closesInDays: 18 },
  { sourceRef: 'REEP-2026-W31-006', title: 'Equity Research Associate', company: 'ICICI Securities', degreeLevel: 'PG', location: 'Mumbai', requiredSkills: ['equity-research', 'valuation', 'financial-modelling', 'excel'], postedDaysAgo: 12, closesInDays: 6 },
  { sourceRef: 'REEP-2026-W31-007', title: 'Product Analyst', company: 'Razorpay', degreeLevel: 'PG', location: 'Bengaluru', requiredSkills: ['sql', 'data-visualisation', 'product-management', 'critical-thinking'], postedDaysAgo: 3, closesInDays: 24 },
  { sourceRef: 'REEP-2026-W31-008', title: 'Operations Manager Trainee', company: 'Delhivery', degreeLevel: 'PG', location: 'Hyderabad', requiredSkills: ['operations-research', 'lean-six-sigma', 'project-management', 'teamwork'], postedDaysAgo: 10, closesInDays: 11 },
  { sourceRef: 'REEP-2026-W31-009', title: 'Consulting Analyst', company: 'Deloitte India', degreeLevel: 'PG', location: 'Bengaluru', requiredSkills: ['case-analysis', 'problem-solving', 'powerpoint', 'business-writing', 'guesstimation'], postedDaysAgo: 2, closesInDays: 26 },
  { sourceRef: 'REEP-2026-W31-010', title: 'Credit Analyst', company: 'HDFC Bank', degreeLevel: 'PG', location: 'Bengaluru', requiredSkills: ['banking-operations', 'risk-management', 'financial-accounting', 'excel'], postedDaysAgo: 14, closesInDays: 4 },
  { sourceRef: 'REEP-2026-W31-011', title: 'Digital Marketing Specialist', company: 'Zoho', degreeLevel: 'PG', location: 'Chennai', requiredSkills: ['seo', 'google-analytics', 'content-writing', 'email-marketing'], postedDaysAgo: 8, closesInDays: 17 },
  { sourceRef: 'REEP-2026-W31-012', title: 'Business Development Manager', company: 'Freshworks', degreeLevel: 'PG', location: 'Chennai', requiredSkills: ['sales-negotiation', 'crm', 'client-communication', 'negotiation'], postedDaysAgo: 20, closesInDays: -2 },

  { sourceRef: 'REEP-2026-W31-013', title: 'Accounts Assistant', company: 'EY Global Delivery Services', degreeLevel: 'UG', location: 'Bengaluru', requiredSkills: ['tally', 'financial-accounting', 'excel', 'gst-taxation'], postedDaysAgo: 5, closesInDays: 16 },
  { sourceRef: 'REEP-2026-W31-014', title: 'Customer Success Associate', company: 'Zoho', degreeLevel: 'UG', location: 'Bengaluru', requiredSkills: ['client-communication', 'crm', 'email-etiquette', 'teamwork'], postedDaysAgo: 4, closesInDays: 20 },
  { sourceRef: 'REEP-2026-W31-015', title: 'Sales Trainee', company: 'Asian Paints', degreeLevel: 'UG', location: 'Hubballi', requiredSkills: ['sales-negotiation', 'public-speaking', 'crm', 'time-management'], postedDaysAgo: 11, closesInDays: 8 },
  { sourceRef: 'REEP-2026-W31-016', title: 'Junior Data Associate', company: 'Mu Sigma', degreeLevel: 'UG', location: 'Bengaluru', requiredSkills: ['excel', 'sql', 'data-cleaning', 'logical-reasoning'], postedDaysAgo: 6, closesInDays: 14 },
  { sourceRef: 'REEP-2026-W31-017', title: 'Content Associate', company: "BYJU'S", degreeLevel: 'UG', location: 'Bengaluru', requiredSkills: ['content-writing', 'business-writing', 'seo', 'canva'], postedDaysAgo: 13, closesInDays: 5 },
  { sourceRef: 'REEP-2026-W31-018', title: 'HR Executive', company: 'Quess Corp', degreeLevel: 'UG', location: 'Bengaluru', requiredSkills: ['recruitment', 'payroll', 'employee-engagement', 'email-etiquette'], postedDaysAgo: 7, closesInDays: 19 },
  { sourceRef: 'REEP-2026-W31-019', title: 'Operations Executive', company: 'Amazon India', degreeLevel: 'UG', location: 'Bengaluru', requiredSkills: ['inventory-management', 'excel', 'process-improvement', 'time-management'], postedDaysAgo: 3, closesInDays: 22 },
  { sourceRef: 'REEP-2026-W31-020', title: 'Digital Marketing Intern', company: 'Dunzo', degreeLevel: 'UG', location: 'Bengaluru', requiredSkills: ['social-media-marketing', 'canva', 'content-writing', 'google-analytics'], postedDaysAgo: 2, closesInDays: 25 },
  { sourceRef: 'REEP-2026-W31-021', title: 'Front Office & Admin Executive', company: 'Taj Hotels', degreeLevel: 'UG', location: 'Bengaluru', requiredSkills: ['client-communication', 'email-etiquette', 'time-management', 'teamwork'], postedDaysAgo: 16, closesInDays: 3 },
];

// ---------------------------------------------------------------------------
// SWOC
// ---------------------------------------------------------------------------

/**
 * What each of the three desks says about a student.
 *
 * Written as three separate voices on purpose. The placement cell talks about
 * shortlists and panels, the mentor about the lab and the week, the programme
 * manager about the curve and the criteria — and the board is only worth
 * looking at if a reader can tell which is which without reading the label.
 */
const SWOC_TEXT: Record<SwocSource, Record<SwocKind, string[]>> = {
  PLACEMENT: {
    STRENGTH: [
      'Holds a position in the mock GD panel without talking over anyone.',
      'Resume reads cleanly — quantified bullets, no filler.',
      'Aptitude scores sit in the top quartile of the batch.',
    ],
    WEAKNESS: [
      'Interview answers ramble; still not using a STAR structure.',
      'Jumps to a number on guesstimates before framing the approach.',
      'Domain vocabulary for finance roles is thin.',
    ],
    OPPORTUNITY: [
      'Analyst-role fit if the SQL certification lands before December.',
      'Communication is strong enough for the client-facing shortlist.',
      'Worth putting forward as a campus ambassador for the drive.',
    ],
    CHALLENGE: [
      'Needs three more interview mocks to be shortlist-ready for December.',
      'Confidence drops sharply the moment a panel pushes back.',
      'Certification backlog has to close before the eligibility cut.',
    ],
  },
  MENTOR: {
    STRENGTH: [
      'Turns up to every supervised lab and works the full block.',
      'Asks for feedback and actually applies it the following week.',
      'Quietly unblocks the rest of the lab group on Excel formulas.',
    ],
    WEAKNESS: [
      'Logs long sessions with very little provider progress to show for them.',
      'Keeps deferring the graded quizzes that close a certification out.',
      'Attendance in the instructor-led block has slipped two weeks running.',
    ],
    OPPORTUNITY: [
      'Ready for the advanced Excel track — the fundamentals are solid.',
      'Would grow from leading the next case-study group.',
      'Should sit the next aptitude mock; the gap is smaller than they think.',
    ],
    CHALLENGE: [
      'Balancing REE101 with the REE103 lab hours is the recurring struggle.',
      'Travel time to campus is eating the evening study block.',
      'Needs a weekly commitment they will keep, not an ambitious one.',
    ],
  },
  PM: {
    STRENGTH: [
      'Certification pace is ahead of the expected curve for the cohort.',
      'One of the few keeping the time log current without a reminder.',
      'Reliable on group deliverables — their piece arrives finished.',
    ],
    WEAKNESS: [
      'Self-learning hours are well under the weekly target.',
      'Backfills the time log in one sitting rather than logging as they go.',
      'Has not started the optional certification the specialisation expects.',
    ],
    OPPORTUNITY: [
      'Eligible for the industry capstone if attendance holds above 85%.',
      'A candidate for the peer-mentoring pilot next term.',
      'Suited to the operations specialisation on current evidence.',
    ],
    CHALLENGE: [
      'Pace against the expected curve has to recover before the mid-term review.',
      'Attendance is the binding constraint on placement eligibility.',
      'Two core certifications are past their due week.',
    ],
  },
};

const MOCK_NOTES: Record<MockType, string[]> = {
  GD: [
    'Entered the discussion early and summarised well at the close.',
    'Spoke twice, both times restating someone else. Needs a point of their own.',
    'Good content, but interrupted twice — cost them on the behaviour score.',
  ],
  INTERVIEW: [
    'Strong on the REEP projects; vague on why this sector.',
    'Answers ran long. Practised STAR afterwards and the second attempt was tighter.',
    'Handled the stress question calmly. Ready for a real panel.',
  ],
  APTITUDE: [
    'Quant strong, verbal reasoning is the gap.',
    'Ran out of time — accuracy fine on what was attempted.',
    'Steady improvement on data interpretation since the last paper.',
  ],
};

// ---------------------------------------------------------------------------
// University results
// ---------------------------------------------------------------------------

type SubjectSeed = { code: string; name: string; credits: number };

/// VTU subject lists, keyed by degree level and semester. Real course codes,
/// because a marks screen that shows plausible-but-invented codes is the kind
/// of thing that gets screenshotted and then questioned.
const SUBJECTS: Record<DegreeLevel, Record<number, SubjectSeed[]>> = {
  PG: {
    1: [
      { code: '22MBA11', name: 'Management and Organisational Behaviour', credits: 4 },
      { code: '22MBA12', name: 'Managerial Economics', credits: 4 },
      { code: '22MBA13', name: 'Accounting for Managers', credits: 4 },
      { code: '22MBA14', name: 'Statistics for Management', credits: 4 },
      { code: '22MBA15', name: 'Marketing Management', credits: 3 },
      { code: '22MBA16', name: 'Managerial Communication', credits: 3 },
    ],
    2: [
      { code: '22MBA21', name: 'Human Resource Management', credits: 4 },
      { code: '22MBA22', name: 'Financial Management', credits: 4 },
      { code: '22MBA23', name: 'Research Methodology', credits: 4 },
      { code: '22MBA24', name: 'Operations Research', credits: 4 },
      { code: '22MBA25', name: 'Entrepreneurship Development', credits: 3 },
    ],
    3: [
      { code: '22MBA31', name: 'Strategic Management', credits: 4 },
      { code: '22MBA32', name: 'Business Analytics', credits: 4 },
      { code: '22MBA33', name: 'International Business', credits: 3 },
      { code: '22MBAMM303', name: 'Digital Marketing', credits: 3 },
      { code: '22MBAFM303', name: 'Investment Management', credits: 3 },
    ],
  },
  UG: {
    3: [
      { code: '22BBA31', name: 'Cost Accounting', credits: 4 },
      { code: '22BBA32', name: 'Business Statistics', credits: 4 },
      { code: '22BBA33', name: 'Corporate Law', credits: 3 },
      { code: '22BBA34', name: 'Marketing Management', credits: 3 },
      { code: '22BBA35', name: 'Banking and Insurance', credits: 3 },
    ],
    4: [
      { code: '22BBA41', name: 'Financial Management', credits: 4 },
      { code: '22BBA42', name: 'Human Resource Management', credits: 4 },
      { code: '22BBA43', name: 'Operations Management', credits: 3 },
      { code: '22BBA44', name: 'Income Tax', credits: 3 },
      { code: '22BBA45', name: 'Entrepreneurship', credits: 3 },
    ],
    5: [
      { code: '22BBA51', name: 'Business Analytics', credits: 4 },
      { code: '22BBA52', name: 'Strategic Management', credits: 4 },
      { code: '22BBA53', name: 'Retail Management', credits: 3 },
      { code: '22BBA54', name: 'Supply Chain Management', credits: 3 },
      { code: '22BBA55', name: 'Business Research Methods', credits: 3 },
    ],
  },
};

/// VTU's 10-point ladder over a 100-mark total.
function gradePoint(total: number): number {
  if (total >= 90) return 10;
  if (total >= 80) return 9;
  if (total >= 70) return 8;
  if (total >= 60) return 7;
  if (total >= 50) return 6;
  if (total >= 45) return 5;
  if (total >= 40) return 4;
  return 0;
}

function resultClassFor(cgpa: number): string {
  if (cgpa >= 7.75) return 'FIRST CLASS WITH DISTINCTION';
  if (cgpa >= 6.75) return 'FIRST CLASS';
  if (cgpa >= 5.75) return 'SECOND CLASS';
  return 'PASS';
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** How engaged a student is — drives every generated number downstream. */
type Profile = 'star' | 'strong' | 'steady' | 'slipping' | 'atrisk';

const PROFILE_SETTINGS: Record<
  Profile,
  {
    /** Fraction of the expected completion curve they actually achieve. */
    paceFactor: [number, number];
    attendance: [number, number];
    /** Sessions per week. */
    density: [number, number];
    /** Provider progress-points gained per logged hour. */
    yield: [number, number];
    idleDays: [number, number];
  }
> = {
  star: { paceFactor: [1.05, 1.2], attendance: [0.96, 1], density: [3.2, 4.2], yield: [2.6, 3.4], idleDays: [0, 1] },
  strong: { paceFactor: [0.9, 1.05], attendance: [0.9, 0.98], density: [2.6, 3.4], yield: [2.1, 2.9], idleDays: [0, 2] },
  steady: { paceFactor: [0.72, 0.9], attendance: [0.84, 0.93], density: [2.0, 2.8], yield: [1.6, 2.3], idleDays: [1, 3] },
  slipping: { paceFactor: [0.45, 0.68], attendance: [0.78, 0.9], density: [1.2, 2.0], yield: [1.0, 1.7], idleDays: [2, 4] },
  atrisk: { paceFactor: [0.18, 0.4], attendance: [0.58, 0.78], density: [0.4, 1.1], yield: [0.3, 1.0], idleDays: [3, 9] },
};

type StudentSeed = {
  name: string;
  email: string;
  usn: string;
  profile: Profile;
  /** Overrides so the wireframe personas land on their published numbers. */
  forceIdleDays?: number;
  forceAttendance?: number;
  /**
   * Skip every one of the newer models — no skills, SWOC, mocks, results,
   * time sheet, login history or applications.
   *
   * Deliberate, and worth keeping. A student who has signed in once and used
   * none of it is the case every new screen gets wrong, and without one in the
   * seed the empty state is only ever discovered in front of a real fresher.
   */
  blank?: boolean;
};

const GROUP_B: StudentSeed[] = [
  { name: 'Ananya R.', email: 'ananya.r@bgscet.ac.in', usn: '1BG24MBA001', profile: 'strong', forceIdleDays: 0, forceAttendance: 0.96 },
  { name: 'Rohan M.', email: 'rohan.m@bgscet.ac.in', usn: '1BG24MBA002', profile: 'slipping', forceIdleDays: 2, forceAttendance: 0.88 },
  { name: 'Aditi K.', email: 'aditi.k@bgscet.ac.in', usn: '1BG24MBA003', profile: 'atrisk', forceIdleDays: 6, forceAttendance: 0.74 },
  { name: 'Simran T.', email: 'simran.t@bgscet.ac.in', usn: '1BG24MBA004', profile: 'atrisk', forceIdleDays: 3, forceAttendance: 0.62 },
  { name: 'Karthik V.', email: 'karthik.v@bgscet.ac.in', usn: '1BG24MBA005', profile: 'star', forceIdleDays: 0, forceAttendance: 1 },
  { name: 'Meera S.', email: 'meera.s@bgscet.ac.in', usn: '1BG24MBA006', profile: 'steady', forceIdleDays: 1, forceAttendance: 0.9 },
  { name: 'Nikhil P.', email: 'nikhil.p@bgscet.ac.in', usn: '1BG24MBA007', profile: 'steady' },
  { name: 'Divya N.', email: 'divya.n@bgscet.ac.in', usn: '1BG24MBA008', profile: 'strong' },
  { name: 'Arjun B.', email: 'arjun.b@bgscet.ac.in', usn: '1BG24MBA009', profile: 'slipping' },
  { name: 'Pooja H.', email: 'pooja.h@bgscet.ac.in', usn: '1BG24MBA010', profile: 'steady' },
  { name: 'Sandeep G.', email: 'sandeep.g@bgscet.ac.in', usn: '1BG24MBA011', profile: 'strong' },
  { name: 'Lakshmi J.', email: 'lakshmi.j@bgscet.ac.in', usn: '1BG24MBA012', profile: 'steady' },
];

/**
 * The undergraduate cohort — a BBA batch in its fifth semester.
 *
 * REEP is not an MBA-only programme, and until this cohort existed the UG half
 * of every screen was theory: `Cohort.degreeLevel`, the UG jobs in the sheet
 * and the eligibility split all had nothing to filter. Ten students is enough
 * to make the split visible without doubling the seed.
 */
const GROUP_UG: StudentSeed[] = [
  { name: 'Vikas D.', email: 'vikas.d@bgscet.ac.in', usn: '1BG23BBA001', profile: 'star' },
  { name: 'Shreya M.', email: 'shreya.m@bgscet.ac.in', usn: '1BG23BBA002', profile: 'strong' },
  { name: 'Naveen K.', email: 'naveen.k@bgscet.ac.in', usn: '1BG23BBA003', profile: 'steady' },
  { name: 'Anusha P.', email: 'anusha.p@bgscet.ac.in', usn: '1BG23BBA004', profile: 'strong' },
  { name: 'Gagan S.', email: 'gagan.s@bgscet.ac.in', usn: '1BG23BBA005', profile: 'slipping' },
  { name: 'Bhavana R.', email: 'bhavana.r@bgscet.ac.in', usn: '1BG23BBA006', profile: 'steady' },
  { name: 'Tarun J.', email: 'tarun.j@bgscet.ac.in', usn: '1BG23BBA007', profile: 'atrisk' },
  { name: 'Nisha B.', email: 'nisha.b@bgscet.ac.in', usn: '1BG23BBA008', profile: 'steady' },
  { name: 'Kiran A.', email: 'kiran.a@bgscet.ac.in', usn: '1BG23BBA009', profile: 'slipping' },
  // The empty state, on purpose. See `StudentSeed.blank`.
  { name: 'Farhan Q.', email: 'farhan.q@bgscet.ac.in', usn: '1BG23BBA010', profile: 'steady', blank: true },
];

const FIRST_NAMES = ['Aarav', 'Isha', 'Vikram', 'Sneha', 'Rahul', 'Kavya', 'Manoj', 'Anjali', 'Suresh', 'Priya', 'Tejas', 'Nandini', 'Harish', 'Shruti', 'Girish', 'Deepa', 'Praveen', 'Rekha', 'Vinay', 'Swathi'];
const LAST_INITIALS = ['A.', 'B.', 'C.', 'D.', 'G.', 'H.', 'J.', 'K.', 'M.', 'N.', 'P.', 'R.', 'S.', 'T.', 'V.'];
const PROFILE_MIX: Profile[] = ['star', 'strong', 'strong', 'steady', 'steady', 'steady', 'slipping', 'slipping', 'atrisk'];

function generateStudents(count: number, usnPrefix: string, startIndex: number): StudentSeed[] {
  const used = new Set<string>();
  const out: StudentSeed[] = [];
  for (let i = 0; i < count; i++) {
    let name = '';
    do {
      name = `${pick(FIRST_NAMES)} ${pick(LAST_INITIALS)}`;
    } while (used.has(name));
    used.add(name);

    const slug = name.toLowerCase().replace(/[^a-z]/g, '');
    out.push({
      name,
      email: `${slug}${startIndex + i}@bgscet.ac.in`,
      usn: `${usnPrefix}${String(startIndex + i).padStart(3, '0')}`,
      profile: PROFILE_MIX[i % PROFILE_MIX.length],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function main() {
  console.log('Clearing existing data…');
  // Children before parents. Anything holding a SetNull foreign key — a resume
  // pointing at a job, a registration pointing at a rule — has to go before the
  // row it points at, or the delete succeeds and quietly blanks a column on the
  // way past.
  await prisma.$transaction([
    prisma.emailVerification.deleteMany(),
    prisma.registration.deleteMany(),
    prisma.registrationRule.deleteMany(),
    prisma.mailLog.deleteMany(),
    prisma.leaveRequest.deleteMany(),
    prisma.jobApplication.deleteMany(),
    prisma.resume.deleteMany(),
    prisma.job.deleteMany(),
    prisma.jobImportRun.deleteMany(),
    prisma.loginDay.deleteMany(),
    prisma.mockAttempt.deleteMany(),
    prisma.swocEntry.deleteMany(),
    prisma.subjectMark.deleteMany(),
    prisma.semesterResult.deleteMany(),
    prisma.skillClaim.deleteMany(),
    prisma.studentSkill.deleteMany(),
    prisma.skill.deleteMany(),
    prisma.timeSheetEntry.deleteMany(),
    prisma.studentProfile.deleteMany(),
    prisma.upload.deleteMany(),
    prisma.alert.deleteMany(),
    prisma.alertRuleConfig.deleteMany(),
    prisma.mentorNote.deleteMany(),
    prisma.scheduleItem.deleteMany(),
    prisma.attendanceRecord.deleteMany(),
    prisma.labSession.deleteMany(),
    prisma.certificationProgress.deleteMany(),
    prisma.enrollment.deleteMany(),
    prisma.certification.deleteMany(),
    prisma.course.deleteMany(),
    prisma.student.deleteMany(),
    prisma.mentor.deleteMany(),
    prisma.cohort.deleteMany(),
    prisma.user.deleteMany(),
    prisma.placementCriteria.deleteMany(),
  ]);

  // The upload rows have just gone, so the bytes they named are unreachable.
  // Leaving them would grow the directory by a set of orphans on every seed —
  // student ids are regenerated each run, so nothing later can ever claim them.
  await rm(path.join(process.cwd(), 'storage', 'uploads'), { recursive: true, force: true });

  // --- curriculum ---
  console.log('Creating curriculum…');
  for (const course of COURSES) {
    await prisma.course.create({
      data: {
        code: course.code,
        name: course.name,
        stage: course.stage,
        dimension: course.dimension,
        semester: course.semester,
        teachingHours: course.teachingHours,
        selfLearningHoursRequired: course.selfLearningHoursRequired,
        modelType: course.modelType,
        durationWeeks: course.durationWeeks,
        description: course.description,
        certifications: {
          create: course.certs.map((c) => ({
            code: c.code,
            name: c.name,
            provider: c.provider,
            requiredHours: c.hours,
            dueWeek: c.dueWeek,
            isOptional: c.optional ?? false,
            link: `https://www.coursera.org/learn/${c.code.toLowerCase()}`,
          })),
        },
      },
    });
  }

  await prisma.placementCriteria.create({
    data: {
      name: 'MBA 2026 placement eligibility',
      active: true,
      minReepCompletionPct: 80,
      minCertCompletionPct: 75,
      minAttendancePct: 85,
      requireCoreCerts: true,
    },
  });

  // --- cohorts ---
  console.log('Creating cohorts and staff…');
  const juniorA = await prisma.cohort.create({
    data: {
      code: 'MBA-2026-A',
      name: 'MBA Batch 2026-28 — Section A',
      batchLabel: '2026-28',
      degreeLevel: 'PG',
      startDate: new Date('2026-05-01T00:00:00Z'),
      endDate: new Date('2028-06-30T00:00:00Z'),
    },
  });
  const juniorB = await prisma.cohort.create({
    data: {
      code: 'MBA-2026-B',
      name: 'MBA Batch 2026-28 — Section B',
      batchLabel: '2026-28',
      degreeLevel: 'PG',
      startDate: new Date('2026-05-01T00:00:00Z'),
      endDate: new Date('2028-06-30T00:00:00Z'),
    },
  });
  const senior = await prisma.cohort.create({
    data: {
      code: 'MBA-2025-A',
      name: 'MBA Batch 2025-27 — Section A',
      batchLabel: '2025-27',
      degreeLevel: 'PG',
      startDate: new Date('2025-05-01T00:00:00Z'),
      endDate: new Date('2027-06-30T00:00:00Z'),
    },
  });
  const undergrad = await prisma.cohort.create({
    data: {
      code: 'BBA-2024-A',
      name: 'BBA Batch 2024-27 — Section A',
      batchLabel: '2024-27',
      degreeLevel: 'UG',
      startDate: new Date('2024-08-01T00:00:00Z'),
      endDate: new Date('2027-06-30T00:00:00Z'),
    },
  });

  // Alert thresholds, per cohort — the admin-configurable layer.
  for (const cohort of [juniorA, juniorB, senior, undergrad]) {
    await prisma.alertRuleConfig.createMany({
      data: [
        { cohortId: cohort.id, ruleKey: 'NO_CHECKIN_N_DAYS', params: { days: 5 }, severity: 'WARNING' },
        { cohortId: cohort.id, ruleKey: 'PACE_BELOW_THRESHOLD', params: { deviationPct: 25 }, severity: 'CRITICAL' },
        { cohortId: cohort.id, ruleKey: 'ATTENDANCE_BELOW_THRESHOLD', params: { minAttendancePct: 75 }, severity: 'WARNING' },
        { cohortId: cohort.id, ruleKey: 'CERT_OVERDUE', params: { graceDays: 0 }, severity: 'WARNING' },
        { cohortId: cohort.id, ruleKey: 'LOW_FOCUS_QUALITY', params: { minProgressPerHour: 1.0, minSessions: 3 }, severity: 'INFO' },
      ],
    });
  }

  const mentorSeeds = [
    { name: 'Prof. Rakesh Iyer', email: 'rakesh.iyer@bgscet.ac.in', group: 'MBA-2026-B', department: 'MBA' },
    { name: 'Prof. Anita Desai', email: 'anita.desai@bgscet.ac.in', group: 'MBA-2026-A', department: 'MBA' },
    { name: 'Prof. Vivek Kulkarni', email: 'vivek.kulkarni@bgscet.ac.in', group: 'MBA-2025-A', department: 'MBA' },
    { name: 'Prof. Kavitha Rao', email: 'kavitha.rao@bgscet.ac.in', group: 'BBA-2024-A', department: 'BBA' },
  ];

  const mentors = [];
  for (const seed of mentorSeeds) {
    const user = await prisma.user.create({
      data: {
        email: seed.email,
        name: seed.name,
        passwordHash: PASSWORD,
        role: Role.MENTOR,
        avatarInitials: seed.name.split(' ').slice(-2).map((p) => p[0]).join(''),
        mentor: { create: { mentorGroup: seed.group, department: seed.department } },
      },
      include: { mentor: true },
    });
    mentors.push(user.mentor!);
  }
  const [mentorB, mentorA, mentorSenior, mentorUG] = mentors;

  const director = await prisma.user.create({
    data: {
      email: 's.manjunath@bgscet.ac.in',
      name: 'Dr. S. Manjunath',
      passwordHash: PASSWORD,
      role: Role.DIRECTOR,
      avatarInitials: 'SM',
    },
  });

  // The programme office signs the second approval on every leave request, and
  // stands in as first approver for the mentor group whose own mentor is away.
  await prisma.mentor.update({
    where: { id: mentorUG.id },
    data: { firstApproverUserId: director.id },
  });

  // --- students ---
  const groups: {
    cohortId: string;
    mentorId: string;
    mentorUserId: string;
    degreeLevel: DegreeLevel;
    stage: Stage;
    semester: number;
    courseCodes: string[];
    termStart: Date;
    students: StudentSeed[];
  }[] = [
    {
      cohortId: juniorB.id,
      mentorId: mentorB.id,
      mentorUserId: mentorB.userId,
      degreeLevel: 'PG',
      stage: 'EXCEL',
      semester: 1,
      courseCodes: ['REE001', 'REE002', 'REE003', 'REE101', 'REE102', 'REE103', 'REE104'],
      termStart: TERM_START,
      students: GROUP_B,
    },
    {
      cohortId: juniorA.id,
      mentorId: mentorA.id,
      mentorUserId: mentorA.userId,
      degreeLevel: 'PG',
      stage: 'EXCEL',
      semester: 1,
      courseCodes: ['REE001', 'REE002', 'REE003', 'REE101', 'REE102', 'REE103', 'REE104'],
      termStart: TERM_START,
      students: generateStudents(18, '1BG24MBA', 101),
    },
    {
      cohortId: senior.id,
      mentorId: mentorSenior.id,
      mentorUserId: mentorSenior.userId,
      degreeLevel: 'PG',
      stage: 'ELEVATE',
      semester: 3,
      courseCodes: ['REE201', 'REE202', 'REE203', 'REE301', 'REE401', 'REE402'],
      termStart: SENIOR_TERM_START,
      students: generateStudents(16, '1BG23MBA', 201),
    },
    // Appended last on purpose: `generateStudents` draws from the same seeded
    // PRNG as everything above it, so adding a group anywhere earlier would
    // silently renumber the existing thirty-four students' data.
    {
      cohortId: undergrad.id,
      mentorId: mentorUG.id,
      mentorUserId: mentorUG.userId,
      degreeLevel: 'UG',
      stage: 'ELEVATE',
      semester: 5,
      courseCodes: ['REE201', 'REE202', 'REE401', 'REE402'],
      termStart: SENIOR_TERM_START,
      students: GROUP_UG,
    },
  ];

  const courseByCode = new Map(COURSES.map((c) => [c.code, c]));
  let studentCount = 0;

  /// Everything the later passes need about a student, gathered as the loop
  /// creates them so the newer models can be written in bulk afterwards rather
  /// than one round trip at a time inside it.
  type SeededStudent = {
    id: string;
    userId: string;
    name: string;
    email: string;
    usn: string;
    profile: Profile;
    degreeLevel: DegreeLevel;
    semester: number;
    mentorUserId: string;
    blank: boolean;
  };
  const seeded: SeededStudent[] = [];

  for (const group of groups) {
    for (const seed of group.students) {
      const settings = PROFILE_SETTINGS[seed.profile];
      const paceFactor = between(...settings.paceFactor);
      const attendanceRate = seed.forceAttendance ?? between(...settings.attendance);
      const density = between(...settings.density);
      const yieldPerHour = between(...settings.yield);
      const idleDays = seed.forceIdleDays ?? intBetween(...settings.idleDays);

      const user = await prisma.user.create({
        data: {
          email: seed.email,
          name: seed.name,
          passwordHash: PASSWORD,
          role: Role.STUDENT,
          avatarInitials: seed.name.split(' ').map((p) => p[0]).join(''),
          lastLoginAt: addDays(TODAY, -idleDays),
          student: {
            create: {
              usn: seed.usn,
              cohortId: group.cohortId,
              mentorId: group.mentorId,
              currentStage: group.stage,
              currentSemester: group.semester,
              enrolledAt: group.termStart,
              weeklyHourTarget: 12,
            },
          },
        },
        include: { student: true },
      });
      const student = user.student!;
      studentCount += 1;
      seeded.push({
        id: student.id,
        userId: user.id,
        name: seed.name,
        email: seed.email,
        usn: seed.usn,
        profile: seed.profile,
        degreeLevel: group.degreeLevel,
        semester: group.semester,
        mentorUserId: group.mentorUserId,
        blank: seed.blank ?? false,
      });

      const weeksElapsed = Math.max(
        (TODAY.getTime() - group.termStart.getTime()) / (7 * 86_400_000),
        1,
      );

      for (const code of group.courseCodes) {
        const course = courseByCode.get(code)!;
        // Reboot is behind them: everyone finished it.
        const isPast = course.stage === 'REBOOT';

        const courseProgress = isPast
          ? 1
          : Math.min(
              (weeksElapsed / course.durationWeeks) * paceFactor,
              0.98,
            );

        const lecturesTotal = course.lectures ?? 0;
        const lecturesAttended = Math.round(
          lecturesTotal * Math.min(courseProgress / 0.55, 1) * attendanceRate,
        );

        await prisma.enrollment.create({
          data: {
            studentId: student.id,
            courseCode: code,
            status: isPast ? ProgressStatus.COMPLETED : ProgressStatus.IN_PROGRESS,
            teachingHoursAttended: Number(
              (course.teachingHours * (isPast ? 1 : Math.min(courseProgress / 0.6, 1)) * attendanceRate).toFixed(1),
            ),
            selfLearningHoursLogged: Number(
              (course.selfLearningHoursRequired * courseProgress).toFixed(1),
            ),
            lecturesAttended: Math.min(lecturesAttended, lecturesTotal),
            lecturesTotal,
            startedAt: group.termStart,
            completedAt: isPast ? addDays(group.termStart, -20) : null,
          },
        });

        // --- certifications ---
        for (const cert of course.certs) {
          const dueDate = isPast
            ? addDays(group.termStart, -21 + cert.dueWeek * 2)
            : addDays(group.termStart, cert.dueWeek * 7);

          const expected = Math.min((weeksElapsed / cert.dueWeek) * 100, 100);
          const progressPct = isPast
            ? 100
            : Math.max(0, Math.min(expected * paceFactor * between(0.9, 1.1), 100));

          const completed = progressPct >= 99.5;
          await prisma.certificationProgress.create({
            data: {
              studentId: student.id,
              certCode: cert.code,
              status: completed
                ? ProgressStatus.COMPLETED
                : progressPct > 0
                  ? ProgressStatus.IN_PROGRESS
                  : ProgressStatus.NOT_STARTED,
              progressPct: Number(progressPct.toFixed(1)),
              hoursLogged: Number(((cert.hours * progressPct) / 100).toFixed(1)),
              dueDate,
              startedAt: progressPct > 0 ? group.termStart : null,
              completedAt: completed ? addDays(group.termStart, cert.dueWeek * 5) : null,
              lastSyncedAt: rand() > 0.25 ? addDays(TODAY, -intBetween(0, 3)) : null,
              selfReported: rand() > 0.7,
            },
          });
        }

        // --- instructor-led attendance ---
        // Every course with teaching hours takes a register, not just the
        // lecture-only ones — otherwise the sample is too small for an
        // attendance percentage to mean anything.
        if (course.teachingHours > 0 && !isPast) {
          const totalSessions = lecturesTotal || Math.ceil(course.teachingHours / 1.5);
          const held = Math.max(
            Math.min(
              Math.ceil((weeksElapsed / course.durationWeeks) * totalSessions),
              totalSessions,
            ),
            1,
          );
          const spacingDays = (course.durationWeeks * 7) / totalSessions;
          const records = Array.from({ length: held }, (_, i) => ({
            studentId: student.id,
            courseCode: code,
            sessionNo: i + 1,
            sessionDate: addDays(group.termStart, Math.round((i + 1) * spacingDays)),
            present: rand() < attendanceRate,
          }));
          await prisma.attendanceRecord.createMany({ data: records });
        }
      }

      // --- lab / self-learning sessions over the last 12 weeks ---
      const sessionCourses = group.courseCodes.filter((c) => {
        const course = courseByCode.get(c)!;
        return course.stage !== 'REBOOT' && course.selfLearningHoursRequired > 0;
      });

      if (sessionCourses.length > 0) {
        const sessions: {
          courseCode: string;
          module: string;
          mode: LearningMode;
          source: CheckInSource;
          checkInAt: Date;
          checkOutAt: Date;
          /// Seeded history was recorded as it happened; without this every
          /// generated session would date from the seed run and show up as
          /// backfilled on the first screen that compares the two.
          createdAt: Date;
          durationMin: number;
          progressAtCheckIn: number;
          progressAtCheckOut: number;
          progressDeltaPct: number;
          mentorConfirmed: boolean;
        }[] = [];

        let runningProgress = between(4, 12);

        for (let dayAgo = 84; dayAgo >= idleDays; dayAgo--) {
          const day = addDays(TODAY, -dayAgo);
          const weekday = day.getUTCDay();
          if (weekday === 0) continue; // no Sunday sessions

          if (rand() > density / 6) continue;

          const courseCode = pick(sessionCourses);
          const modules = MODULES[courseCode] ?? ['Self-study'];
          const mode: LearningMode =
            weekday <= 3 ? 'SUPERVISED_LAB' : rand() > 0.45 ? 'INDEPENDENT' : 'SUPERVISED_LAB';

          const startHour = mode === 'SUPERVISED_LAB' ? intBetween(9, 15) : intBetween(17, 21);
          const checkInAt = new Date(day);
          checkInAt.setUTCHours(startHour, intBetween(0, 55), 0, 0);

          // At-risk students produce the short "tapped in and left" sessions.
          const abandoned = seed.profile === 'atrisk' && rand() < 0.35;
          const durationMin = abandoned ? intBetween(8, 22) : intBetween(45, 185);
          const checkOutAt = new Date(checkInAt.getTime() + durationMin * 60_000);

          const gained = abandoned
            ? Number((rand() * 0.4).toFixed(1))
            : Number(((durationMin / 60) * yieldPerHour * between(0.7, 1.3)).toFixed(1));

          const before = runningProgress;
          runningProgress = Math.min(runningProgress + gained, 100);

          sessions.push({
            courseCode,
            module: pick(modules),
            mode,
            source:
              mode === 'SUPERVISED_LAB'
                ? rand() > 0.35
                  ? 'LAB_PC'
                  : 'BADGE'
                : 'SELF_REPORTED',
            checkInAt,
            checkOutAt,
            createdAt: checkOutAt,
            durationMin,
            progressAtCheckIn: Number(before.toFixed(1)),
            progressAtCheckOut: Number(runningProgress.toFixed(1)),
            progressDeltaPct: Number((runningProgress - before).toFixed(1)),
            mentorConfirmed: mode === 'SUPERVISED_LAB' && rand() > 0.6,
          });
        }

        // Instructor-led blocks, so the mode split has all three bands.
        for (let week = 12; week >= 0; week--) {
          if (rand() < attendanceRate) {
            const day = addDays(TODAY, -week * 7 - 2);
            const checkInAt = new Date(day);
            checkInAt.setUTCHours(10, 0, 0, 0);
            const durationMin = intBetween(90, 150);
            const checkOutAt = new Date(checkInAt.getTime() + durationMin * 60_000);
            sessions.push({
              courseCode: group.courseCodes.find((c) => courseByCode.get(c)!.lectures) ?? sessionCourses[0],
              module: 'Lecture',
              mode: 'INSTRUCTOR_LED',
              source: 'MANUAL',
              checkInAt,
              checkOutAt,
              createdAt: checkOutAt,
              durationMin,
              progressAtCheckIn: 0,
              progressAtCheckOut: 0,
              progressDeltaPct: 0,
              mentorConfirmed: true,
            });
          }
        }

        if (sessions.length > 0) {
          await prisma.labSession.createMany({
            data: sessions.map((s) => ({ ...s, studentId: student.id })),
          });
        }
      }

      // --- upcoming schedule ---
      if (group.stage === 'EXCEL') {
        await prisma.scheduleItem.createMany({
          data: [
            {
              studentId: student.id,
              courseCode: 'REE103',
              type: 'LAB_SESSION',
              title: 'REE103 supervised lab session — Excel Fundamentals for Data Analysis (Module 2)',
              startsAt: addDays(TODAY, 1),
              location: 'Computer Lab 2',
            },
            {
              studentId: student.id,
              courseCode: 'REE102',
              type: 'LECTURE',
              title: 'REE102 Lecture 6 — Reading + Guesstimate Practice',
              startsAt: addDays(TODAY, 3),
              location: 'MBA Block, Room 204',
            },
            {
              studentId: student.id,
              courseCode: 'REE101',
              type: 'CERT_DEADLINE',
              title: 'Certification deadline: Leadership Skills (IIM Ahmedabad) — REE101',
              startsAt: addDays(TODAY, 4),
            },
          ],
        });
      }

      // --- a blank profile so the resume builder has somewhere to write ---
      await prisma.studentProfile.create({
        data: {
          studentId: student.id,
          email: seed.email,
          city: 'Bengaluru, Karnataka',
          education: [
            {
              degree: 'MBA (Master of Business Administration)',
              institution: 'BGS College of Engineering & Technology, Bengaluru',
              year: group.stage === 'ELEVATE' ? '2025 – 2027' : '2026 – 2028',
              score: 'In progress',
            },
          ],
          experience: [],
          projects: [],
          skills: [],
          achievements: [],
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Skill catalogue, and who holds what
  // -------------------------------------------------------------------------

  console.log('Creating the skill catalogue…');
  await prisma.skill.createMany({ data: SKILLS });
  const skillRows = await prisma.skill.findMany({ select: { id: true, slug: true } });
  const skillIdBySlug = new Map(skillRows.map((s) => [s.slug, s.id]));
  /// Only the slugs some job actually asks for. Drawing most of a student's
  /// skills from here rather than from all eighty is what makes the match
  /// percentages on the board spread across a believable range instead of
  /// clustering near zero.
  const demandedSlugs = [...new Set(JOBS.flatMap((j) => j.requiredSkills))];
  const otherSlugs = SKILLS.map((s) => s.slug).filter((s) => !demandedSlugs.includes(s));

  const activeStudents = seeded.filter((s) => !s.blank);

  const studentSkills: {
    studentId: string;
    skillId: string;
    level: number;
    verified: boolean;
  }[] = [];

  for (const student of activeStudents) {
    const settings = PROFILE_SETTINGS[student.profile];
    // A star holds more, and holds it more deeply. The count stays inside the
    // 4–8 band whatever the profile, so no screen has to cope with a student
    // carrying one skill or thirty.
    const count = intBetween(4, 8);
    const strength = settings.paceFactor[1];

    const slugs = [
      ...UNIVERSAL_SKILLS,
      ...sample(
        demandedSlugs.filter((s) => !UNIVERSAL_SKILLS.includes(s)),
        Math.max(count - 3, 1),
      ),
      ...sample(otherSlugs, 1),
    ].slice(0, count);

    for (const slug of [...new Set(slugs)]) {
      const skillId = skillIdBySlug.get(slug);
      if (!skillId) continue;
      studentSkills.push({
        studentId: student.id,
        skillId,
        level: Math.max(1, Math.min(5, Math.round(strength * between(2.2, 4.6)))),
        // Roughly half are mentor-verified; the rest are the student's word for
        // it, which is exactly the distinction the resume builder cares about.
        verified: rand() < 0.45,
      });
    }
  }
  await prisma.studentSkill.createMany({ data: studentSkills, skipDuplicates: true });

  // --- claims awaiting a mentor, with a real file behind each one ---
  //
  // The bytes are written to `storage/uploads/` as the app would write them.
  // A claim row pointing at a file that is not on disk turns the first click on
  // the review queue into a 404, and a reviewer cannot tell a seeding shortcut
  // from a genuinely lost upload.
  console.log('Creating skill claims and their evidence files…');
  const claimants = activeStudents.filter((s) => s.usn.endsWith('001') || s.usn.endsWith('002') || s.usn.endsWith('005'));
  for (const [index, student] of claimants.entries()) {
    const slug = pick(demandedSlugs);
    const skillId = skillIdBySlug.get(slug);
    if (!skillId) continue;

    const storedName = `${randomUUID()}.pdf`;
    const dir = path.join(process.cwd(), 'storage', 'uploads', student.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, storedName), PLACEHOLDER_PDF);

    const decided = index % 3 === 0;
    const upload = await prisma.upload.create({
      data: {
        studentId: student.id,
        kind: 'CERTIFICATE_PROOF',
        title: `Course completion certificate — ${SKILLS.find((s) => s.slug === slug)?.name ?? slug}`,
        originalName: `${slug}-certificate.pdf`,
        storedName,
        mimeType: 'application/pdf',
        sizeBytes: PLACEHOLDER_PDF.length,
        status: decided ? 'VERIFIED' : 'PENDING_REVIEW',
        reviewedById: decided ? student.mentorUserId : null,
        reviewedAt: decided ? addDays(TODAY, -4) : null,
        uploadedAt: addDays(TODAY, -intBetween(5, 20)),
      },
    });

    await prisma.skillClaim.create({
      data: {
        studentId: student.id,
        skillId,
        uploadId: upload.id,
        claimedLevel: intBetween(3, 5),
        status: decided ? 'VERIFIED' : 'PENDING_REVIEW',
        reviewedById: decided ? student.mentorUserId : null,
        reviewedAt: decided ? addDays(TODAY, -4) : null,
        reviewNote: decided ? 'Certificate matches the claimed course and the hours logged.' : null,
        createdAt: addDays(TODAY, -intBetween(5, 20)),
      },
    });

    if (decided) {
      await prisma.studentSkill.updateMany({
        where: { studentId: student.id, skillId },
        data: { verified: true, evidenceUploadId: upload.id },
      });
    }
  }

  // -------------------------------------------------------------------------
  // University results
  // -------------------------------------------------------------------------

  console.log('Creating semester results…');
  for (const student of activeStudents) {
    const available = Object.keys(SUBJECTS[student.degreeLevel]).map(Number).sort((a, b) => a - b);
    // The semesters they have actually sat, ending at the one they are in — at
    // most the last three, because a marks screen showing six is a scroll, not
    // a summary. The current semester is the in-progress row: internals
    // recorded, nothing published.
    const semesters = available.filter((s) => s <= student.semester).slice(-3);
    if (semesters.length === 0) continue;

    const settings = PROFILE_SETTINGS[student.profile];
    const ability = (settings.paceFactor[0] + settings.paceFactor[1]) / 2;
    const points: { gp: number; credits: number }[] = [];

    for (const semester of semesters) {
      const inProgress = semester === student.semester;
      const subjects = SUBJECTS[student.degreeLevel][semester];

      const marks = subjects.map((subject) => {
        const internal = Math.round(Math.min(50, Math.max(14, 26 * ability + between(4, 16))));
        const external = inProgress
          ? 0
          : Math.round(Math.min(50, Math.max(10, 24 * ability + between(3, 18))));
        const total = internal + external;
        return {
          subjectCode: subject.code,
          subjectName: subject.name,
          credits: subject.credits,
          internal,
          external,
          // VTU needs 40% overall and a minimum in the external paper.
          passed: inProgress ? true : total >= 40 && external >= 18,
          total,
        };
      });

      let sgpa: number | null = null;
      let cgpa: number | null = null;
      if (!inProgress) {
        const semCredits = marks.reduce((sum, m) => sum + m.credits, 0);
        sgpa = Number(
          (marks.reduce((sum, m) => sum + gradePoint(m.total) * m.credits, 0) / semCredits).toFixed(2),
        );

        // CGPA is cumulative, so it carries every semester seen so far in this
        // student's loop — which is why `points` lives outside it.
        for (const mark of marks) {
          points.push({ gp: gradePoint(mark.total), credits: mark.credits });
        }
        const allCredits = points.reduce((sum, p) => sum + p.credits, 0);
        cgpa = Number(
          (points.reduce((sum, p) => sum + p.gp * p.credits, 0) / allCredits).toFixed(2),
        );
      }

      await prisma.semesterResult.create({
        data: {
          studentId: student.id,
          semester,
          sgpa,
          cgpa,
          resultClass: cgpa === null ? null : resultClassFor(cgpa),
          // Results publish a few weeks after a semester closes, so the most
          // recent published one is dated well before today.
          publishedOn: inProgress
            ? null
            : addDays(TODAY, -((student.semester - semester) * 150) - 40),
          subjects: { create: marks },
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // SWOC, mocks and the login streak
  // -------------------------------------------------------------------------

  console.log('Creating SWOC entries, mock attempts and login history…');

  const swocRows: {
    studentId: string;
    source: SwocSource;
    kind: SwocKind;
    text: string;
    weight: number;
    authorUserId: string;
    recordedAt: Date;
  }[] = [];

  const SOURCES: SwocSource[] = ['PLACEMENT', 'MENTOR', 'PM'];
  const KINDS: SwocKind[] = ['STRENGTH', 'WEAKNESS', 'OPPORTUNITY', 'CHALLENGE'];

  for (const student of activeStudents) {
    // All three desks write about every student — the point of the board is
    // that the three readings sit side by side, and a missing source reads as
    // a disagreement that was never recorded.
    for (const source of SOURCES) {
      const struggling = student.profile === 'atrisk' || student.profile === 'slipping';
      const kinds: SwocKind[] = struggling
        ? ['WEAKNESS', 'CHALLENGE', pick(KINDS)]
        : ['STRENGTH', 'OPPORTUNITY', pick(KINDS)];

      for (const kind of [...new Set(kinds)]) {
        swocRows.push({
          studentId: student.id,
          source,
          kind,
          text: pick(SWOC_TEXT[source][kind]),
          weight: intBetween(2, 5),
          authorUserId: source === 'MENTOR' ? student.mentorUserId : director.id,
          recordedAt: addDays(TODAY, -intBetween(4, 60)),
        });
      }
    }
  }
  await prisma.swocEntry.createMany({ data: swocRows });

  const mockRows: {
    studentId: string;
    type: MockType;
    takenOn: Date;
    score: number | null;
    maxScore: number | null;
    evaluatorUserId: string;
    notes: string;
  }[] = [];

  const MOCK_TYPES: MockType[] = ['GD', 'INTERVIEW', 'APTITUDE'];

  for (const student of activeStudents) {
    const settings = PROFILE_SETTINGS[student.profile];
    const ability = (settings.paceFactor[0] + settings.paceFactor[1]) / 2;

    for (const type of MOCK_TYPES) {
      const attempts = intBetween(1, 2);
      for (let i = 0; i < attempts; i++) {
        // Aptitude papers are marked out of 100, interviews out of 10, and a
        // GD is often just a debrief. The nulls here are the reason `score` and
        // `maxScore` are both nullable rather than one stored percentage.
        const maxScore = type === 'APTITUDE' ? 100 : type === 'INTERVIEW' ? 10 : 10;
        const unscored = type === 'GD' && rand() < 0.4;
        const raw = maxScore * Math.min(0.95, Math.max(0.25, ability * between(0.7, 1.1)));

        mockRows.push({
          studentId: student.id,
          type,
          takenOn: addDays(TODAY, -intBetween(7, 90)),
          score: unscored ? null : Number(raw.toFixed(1)),
          maxScore: unscored ? null : maxScore,
          evaluatorUserId: rand() > 0.5 ? student.mentorUserId : director.id,
          notes: pick(MOCK_NOTES[type]),
        });
      }
    }
  }
  await prisma.mockAttempt.createMany({ data: mockRows });

  // --- 60 days of sign-in history, gaps and all ---
  const loginRows: { userId: string; day: Date }[] = [];
  for (const student of activeStudents) {
    const settings = PROFILE_SETTINGS[student.profile];
    // Roughly the inverse of how many idle days the profile allows: a star
    // shows up almost daily, an at-risk student in bursts with long silences.
    const showRate = 1 - Math.min(0.75, settings.idleDays[1] / 12);
    let skipRun = 0;

    for (let dayAgo = 59; dayAgo >= 0; dayAgo--) {
      const day = addDays(TODAY, -dayAgo);
      if (day.getUTCDay() === 0) continue; // Sundays, campus closed

      if (skipRun > 0) {
        skipRun -= 1;
        continue;
      }
      // Occasionally drop a whole stretch, so a streak calculation has real
      // breaks to find rather than a uniform coin flip.
      if (rand() < 0.06) {
        skipRun = intBetween(2, settings.idleDays[1] + 2);
        continue;
      }
      if (rand() < showRate) loginRows.push({ userId: student.userId, day: dateOnly(day) });
    }
  }
  // Staff sign in too, and the streak card on a mentor's own page reads these.
  for (const mentor of mentors) {
    for (let dayAgo = 59; dayAgo >= 0; dayAgo--) {
      const day = addDays(TODAY, -dayAgo);
      if (day.getUTCDay() === 0 || rand() < 0.2) continue;
      loginRows.push({ userId: mentor.userId, day: dateOnly(day) });
    }
  }
  await prisma.loginDay.createMany({ data: loginRows, skipDuplicates: true });

  // -------------------------------------------------------------------------
  // The five-bucket time sheet
  // -------------------------------------------------------------------------
  //
  // Only a handful of students keep it, which is the truth about any voluntary
  // log and also the point: the screens that read it have to render both a full
  // week and nothing at all.
  console.log('Creating time sheets…');
  const timeSheetUsns = ['1BG24MBA001', '1BG24MBA002', '1BG24MBA003', '1BG24MBA005', '1BG23BBA001'];
  const timeSheetRows: {
    studentId: string;
    day: Date;
    activity: DayActivity;
    minutes: number;
  }[] = [];

  for (const usn of timeSheetUsns) {
    const student = seeded.find((s) => s.usn === usn);
    if (!student) continue;
    const settings = PROFILE_SETTINGS[student.profile];
    const effort = (settings.density[0] + settings.density[1]) / 8;

    for (let dayAgo = 6; dayAgo >= 0; dayAgo--) {
      const day = addDays(TODAY, -dayAgo);
      const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;

      const sleeping = intBetween(360, 510);
      const lectures = weekend ? 0 : intBetween(120, 240);
      const coursework = Math.round(intBetween(60, 180) * effort);
      const skilling = Math.round(intBetween(30, 150) * effort);
      // Leisure absorbs the rest of the day, so the five buckets add to 1440
      // for these students — the schema does not require it, but a sheet a
      // student filled in properly does.
      const leisure = Math.max(60, 1440 - sleeping - lectures - coursework - skilling);

      for (const [activity, minutes] of [
        ['SLEEPING', sleeping],
        ['LECTURES', lectures],
        ['COURSEWORK', coursework],
        ['SKILLING', skilling],
        ['LEISURE', leisure],
      ] as [DayActivity, number][]) {
        if (minutes <= 0) continue;
        timeSheetRows.push({ studentId: student.id, day: dateOnly(day), activity, minutes });
      }
    }
  }
  await prisma.timeSheetEntry.createMany({ data: timeSheetRows, skipDuplicates: true });

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  console.log('Creating the weekly jobs sheet…');
  const importRun = await prisma.jobImportRun.create({
    data: {
      fileName: 'reep-jobs-2026-W31.xlsx',
      uploadedById: director.id,
      startedAt: addDays(TODAY, -2),
      finishedAt: new Date(addDays(TODAY, -2).getTime() + 4_200),
      rowsSeen: JOBS.length + 2,
      rowsCreated: JOBS.length,
      rowsUpdated: 0,
      // A partly good sheet still imports. These two rows are why the run
      // record is worth keeping even when nothing went badly wrong overall.
      errors: [
        { row: 14, column: 'closesOn', message: 'Unparseable date "ASAP" — row skipped' },
        { row: 23, column: 'degreeLevel', message: 'Blank degree level — row skipped' },
      ],
    },
  });

  await prisma.job.createMany({
    data: JOBS.map((job) => ({
      sourceRef: job.sourceRef,
      title: job.title,
      company: job.company,
      degreeLevel: job.degreeLevel,
      location: job.location,
      applyUrl: `https://careers.example.com/${job.sourceRef.toLowerCase()}`,
      description: `${job.company} is hiring a ${job.title} in ${job.location}. Campus drive through the BGSCET placement cell; shortlisting is on the REEP record and the skills listed against this posting.`,
      requiredSkills: job.requiredSkills,
      postedOn: addDays(TODAY, -job.postedDaysAgo),
      closesOn: addDays(TODAY, job.closesInDays),
      importRunId: importRun.id,
    })),
  });

  const jobRows = await prisma.job.findMany({ select: { id: true, degreeLevel: true } });
  const applications: { studentId: string; jobId: string; appliedAt: Date; selfReported: boolean }[] = [];
  for (const student of activeStudents) {
    const eligible = jobRows.filter((j) => j.degreeLevel === student.degreeLevel);
    // The engaged students apply; the disengaged ones are the reason a
    // "students who have applied to nothing" list exists at all.
    const appetite = student.profile === 'atrisk' ? 0 : student.profile === 'slipping' ? 1 : intBetween(1, 4);
    for (const job of sample(eligible, appetite)) {
      applications.push({
        studentId: student.id,
        jobId: job.id,
        appliedAt: addDays(TODAY, -intBetween(0, 12)),
        selfReported: rand() > 0.2,
      });
    }
  }
  await prisma.jobApplication.createMany({ data: applications, skipDuplicates: true });

  // -------------------------------------------------------------------------
  // Leave, registration and the mail log
  // -------------------------------------------------------------------------

  console.log('Creating leave requests, registrations and mail log…');

  const ananya = seeded.find((s) => s.usn === '1BG24MBA001');
  const rohanSeed = seeded.find((s) => s.usn === '1BG24MBA002');

  if (ananya) {
    // Awaiting the first signature — this is what a mentor's queue opens on.
    await prisma.leaveRequest.create({
      data: {
        requesterUserId: ananya.userId,
        fromDate: dateOnly(addDays(TODAY, 6)),
        toDate: dateOnly(addDays(TODAY, 8)),
        reason: "Sister's wedding in Mysuru. Lab hours for the week will be made up the following Saturday.",
        status: 'SUBMITTED',
        firstApproverUserId: ananya.mentorUserId,
        createdAt: addDays(TODAY, -1),
      },
    });
  }

  if (rohanSeed) {
    // Mentor has signed; the programme office has not. The two-step workflow
    // only shows its shape when a request is sitting between the signatures.
    await prisma.leaveRequest.create({
      data: {
        requesterUserId: rohanSeed.userId,
        fromDate: dateOnly(addDays(TODAY, 3)),
        toDate: dateOnly(addDays(TODAY, 4)),
        reason: 'Medical — day surgery and one day of recovery. Certificate to follow.',
        status: 'FIRST_APPROVED',
        firstApproverUserId: rohanSeed.mentorUserId,
        firstDecision: 'APPROVED',
        firstDecidedAt: addDays(TODAY, -2),
        firstNote: 'Genuine, and he is only two sessions behind. Recommending approval.',
        secondApproverUserId: director.id,
        createdAt: addDays(TODAY, -3),
      },
    });
  }

  const autoRule = await prisma.registrationRule.create({
    data: {
      name: 'BGSCET college address — MBA intake',
      emailDomain: 'bgscet.ac.in',
      usnPattern: '^1BG2[0-9]MBA[0-9]{3}$',
      degreeLevel: 'PG',
      cohortId: juniorB.id,
      autoApprove: true,
      priority: 10,
    },
  });
  await prisma.registrationRule.create({
    data: {
      name: 'BGSCET college address — BBA intake',
      emailDomain: 'bgscet.ac.in',
      usnPattern: '^1BG2[0-9]BBA[0-9]{3}$',
      degreeLevel: 'UG',
      cohortId: undergrad.id,
      autoApprove: true,
      priority: 20,
    },
  });
  const reviewRule = await prisma.registrationRule.create({
    data: {
      name: 'Anything else — send it to the programme office',
      autoApprove: false,
      priority: 900,
    },
  });

  // One that will approve itself the moment the address is confirmed, and one
  // a human has to read. Between them they cover both halves of the queue.
  const pendingReg = await prisma.registration.create({
    data: {
      name: 'Sahana Bhat',
      email: 'sahana.bhat@bgscet.ac.in',
      usn: '1BG24MBA113',
      phone: '+91 98860 41125',
      degreeLevel: 'PG',
      cohortId: juniorB.id,
      status: 'PENDING_VERIFICATION',
      matchedRuleId: autoRule.id,
      decisionReason: 'Email domain and USN match the MBA intake rule — auto-approves once the address is confirmed.',
      createdAt: addDays(TODAY, -1),
    },
  });
  await prisma.emailVerification.create({
    data: {
      registrationId: pendingReg.id,
      // Only the hash is ever stored. This one is the SHA-256 of a token that
      // exists nowhere else, so the seeded link is genuinely unusable — which
      // is the property the column is there to give.
      tokenHash: createHash('sha256').update(`seed-verification-${pendingReg.id}`).digest('hex'),
      expiresAt: addDays(TODAY, 2),
      createdAt: addDays(TODAY, -1),
    },
  });

  await prisma.registration.create({
    data: {
      name: 'Imran Shaikh',
      email: 'imran.shaikh@gmail.com',
      usn: 'PENDING',
      phone: '+91 90084 77310',
      degreeLevel: 'PG',
      status: 'PENDING_REVIEW',
      matchedRuleId: reviewRule.id,
      decisionReason: 'Personal email address and no USN issued yet — needs a human to confirm the admission offer.',
      emailVerifiedAt: addDays(TODAY, -4),
      createdAt: addDays(TODAY, -5),
    },
  });

  // Three weeks of job alerts, one row per student per week. The keys are what
  // a re-run of the mailer collides with instead of sending again.
  const mailRows: { kind: string; recipient: string; dedupeKey: string; subject: string; sentAt: Date }[] = [];
  for (const student of activeStudents.slice(0, 12)) {
    for (const week of ['2026-W29', '2026-W30', '2026-W31']) {
      mailRows.push({
        kind: 'job-alert',
        recipient: student.email,
        dedupeKey: `job-alert:${student.id}:${week}`,
        subject: 'New vacancies matched to your REEP skills',
        sentAt: addDays(TODAY, -(week === '2026-W31' ? 2 : week === '2026-W30' ? 9 : 16)),
      });
    }
  }
  await prisma.mailLog.createMany({ data: mailRows, skipDuplicates: true });

  // One student off every leaderboard, so the opt-out is exercised by the seed
  // rather than only by whoever remembers to tick it in staging.
  const optOut = seeded.find((s) => s.usn === '1BG24MBA004');
  if (optOut) {
    await prisma.studentProfile.update({
      where: { studentId: optOut.id },
      data: { leaderboardOptOut: true },
    });
  }

  // --- mentor notes for the wireframe personas ---
  const aditi = await prisma.student.findFirst({
    where: { usn: '1BG24MBA003' },
  });
  if (aditi) {
    await prisma.mentorNote.createMany({
      data: [
        {
          mentorId: mentorB.id,
          studentId: aditi.id,
          noteText:
            "Spoke with Aditi on Jul 5 — said she's overwhelmed juggling REE101 + REE103 lab hours. Agreed on a revised weekly check-in.",
          linkedAction: 'ONE_ON_ONE_SCHEDULED',
          createdAt: new Date('2026-07-05T11:30:00Z'),
        },
        {
          mentorId: mentorB.id,
          studentId: aditi.id,
          noteText:
            'Missed the agreed check-in. Escalating to a flag and copying the programme office.',
          linkedAction: 'FLAGGED',
          createdAt: new Date('2026-07-22T09:15:00Z'),
        },
      ],
    });
  }

  const rohan = await prisma.student.findFirst({ where: { usn: '1BG24MBA002' } });
  if (rohan) {
    await prisma.mentorNote.create({
      data: {
        mentorId: mentorB.id,
        studentId: rohan.id,
        noteText:
          'Nudged about the Leadership Skills certification — he has the hours but keeps deferring the graded quizzes.',
        linkedAction: 'NUDGE_SENT',
        createdAt: new Date('2026-07-28T15:00:00Z'),
      },
    });
  }

  console.log(
    `Seeded ${studentCount} students across 4 cohorts (3 PG, 1 UG); ` +
      `${SKILLS.length} skills, ${JOBS.length} jobs, ${loginRows.length} login days.`,
  );
  console.log('Running the alert rules engine…');

  const { runAlertScan } = await import('../src/lib/rules');
  const scan = await runAlertScan();
  console.log(
    `Alert scan: ${scan.scanned} students, ${scan.opened} alerts opened.`,
  );
  console.log('\nSign in with any seeded email and the password: reep2026');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
