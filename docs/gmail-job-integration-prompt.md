# Prompt: Gmail Job Application Integration for REEP

## Objective

Integrate REEP with students' Gmail accounts to automatically detect, parse, and track job applications. Students apply to jobs across platforms (LinkedIn, Indeed, company careers sites), and REEP will read these application confirmation emails, extract job details, and display a real-time job pipeline dashboard.

**Outcome:** Students and mentors see "Applied to X jobs" with full timeline; directors see aggregate hiring metrics.

---

## Requirements

### Functional Requirements

#### 1. Student Gmail Connection
- [ ] Student clicks "Connect Gmail" on job dashboard
- [ ] Redirects to Google OAuth 2.0 consent screen (read-only scope: `gmail.readonly`)
- [ ] REEP stores refresh token (encrypted in PostgreSQL)
- [ ] Student can disconnect Gmail anytime (revokes token)
- [ ] Show connection status on UI ("Gmail connected ✓" or "Connect Gmail")

#### 2. Email Monitoring & Polling
- [ ] Background worker polls Gmail every 10–15 minutes for each connected student
- [ ] Search for emails matching job application keywords (e.g., "application", "applied", "congratulations", "offer", "rejected")
- [ ] Deduplicate using Gmail message IDs (avoid re-processing same email)
- [ ] Handle Gmail API rate limits gracefully (1M requests/day for 1000 students is feasible)

#### 3. Email Parsing & Data Extraction
- [ ] Parse job application emails to extract:
  - Company name (e.g., "Google", "Amazon", "Acme Corp")
  - Job title (e.g., "Software Engineer", "Data Analyst", "Product Manager")
  - Application status (e.g., "applied", "rejected", "offer", "interview scheduled")
  - Date applied (timestamp from email or inferred)
  - Email source/platform (e.g., "LinkedIn", "Indeed", "company_site", "email")
- [ ] Support multiple email formats:
  - LinkedIn: "You've applied to [Job Title] at [Company]"
  - Indeed: "Your application was received for [Job Title]"
  - Company careers site: Plain text or HTML emails
  - Custom: Generic job confirmation emails
- [ ] Mark uncertain extractions for manual review (confidence < 80%)

#### 4. Database Storage
- [ ] Create `job_applications` table with:
  - `id` (PK)
  - `student_id` (FK to users)
  - `company_name` (string)
  - `job_title` (string)
  - `status` (enum: "applied", "rejected", "offer", "interview_scheduled")
  - `date_applied` (datetime)
  - `email_subject` (original email subject)
  - `email_timestamp` (when REEP saw it)
  - `gmail_message_id` (Gmail's unique ID, for deduplication)
  - `source` (enum: "linkedin", "indeed", "company_site", "email")
  - `created_at`, `updated_at` (REEP timestamps)
- [ ] Add `gmail_refresh_token` to `users` table (encrypted, for OAuth)
- [ ] Add `gmail_connected_at` and `gmail_last_synced_at` to `users` table

#### 5. Student Dashboard
- [ ] Display:
  - "Connected to Gmail" status
  - "Applied to X jobs total"
  - Timeline of applications (sorted by date_applied DESC)
  - Per-application card: Company + Job Title + Status + Date
  - Filter by status (Applied, Rejected, Offer, Interview)
  - "Last synced at" timestamp
  - Manual "Sync Now" button (student can trigger immediate sync)

#### 6. Mentor View
- [ ] Mentor sees students' job applications:
  - Student name + "Applied to X jobs"
  - Filterable by specialization (HR, DM, BA, FA)
  - Help mentor identify opportunities ("Student applied to 3 jobs this week—good pace!")
  - Alert if student has applied to 0 jobs (nudge to apply more)

#### 7. Director View (Optional Phase 2)
- [ ] Aggregate metrics:
  - "X% of students have applied to jobs"
  - "Average applications per student"
  - "Top 10 companies students applied to"
  - "Offer rate: X% of applications resulted in offers"
  - Cohort comparison (this batch vs. last batch)

#### 8. Manual Review & Correction
- [ ] If email parser confidence < 80%, flag for manual review
- [ ] Admin/student can correct extracted data:
  - Change company name
  - Change job title
  - Mark as "not a job application" (false positive)
  - Set actual date if email date is wrong

---

### Non-Functional Requirements

#### Performance
- [ ] Poll all connected students in under 5 minutes total (distributed tasks)
- [ ] Parse email and store in DB in <100ms per email
- [ ] Dashboard load time <1 second (query on `job_applications` should be indexed on `student_id` + `date_applied`)

#### Scalability
- [ ] Support 1000 concurrent students with Gmail connected
- [ ] Gmail API rate limit is 1M requests/day; polling 1000 students every 15 min = ~6000 requests/day (safe margin)
- [ ] Email parsing using local NLP (not remote LLM) to avoid egress gate violations

#### Security & Privacy
- [ ] Gmail refresh tokens encrypted in DB (AES-256, using environment key)
- [ ] OAuth scope strictly read-only (`gmail.readonly`); no write access
- [ ] Only job application emails are read; other emails ignored
- [ ] Student can revoke access anytime (token deleted from DB)
- [ ] No email bodies stored (only metadata: company, job, date)
- [ ] No PII from student's email leaked to external services (respect egress gate rule 1)

#### Reliability
- [ ] Graceful handling of Gmail API errors:
  - 429 (rate limit): Back off and retry after 60s
  - 401 (token expired): Refresh token silently
  - 403 (permission denied): Notify student to re-authenticate
  - Network timeout: Retry up to 3 times with exponential backoff
- [ ] Deduplication: Use Gmail message IDs to avoid re-processing
- [ ] Idempotent: Re-running parser on same email should not create duplicates

---

## Technical Constraints

### 1. Email Parsing Strategy
- **Do NOT send email body to remote LLM** (violates student data egress gate)
- **Use local NLP:**
  - Regex patterns for common formats (LinkedIn, Indeed)
  - spaCy for entity extraction (company, job title)
  - Confidence scoring (regex + spaCy agreement = high confidence)
  - Fallback: Ask student to manually confirm if confidence < 80%

### 2. OAuth Flow
- Use Google OAuth 2.0 (not service account)
- Redirect URI: `https://<reep-domain>/api/auth/gmail/callback`
- Scope: `https://www.googleapis.com/auth/gmail.readonly`
- Refresh token stored in DB; access token obtained from refresh token on each poll

### 3. Database Considerations
- `job_applications` table will have up to ~10K–50K rows (1000 students × 10–50 apps each)
- Index on `(student_id, date_applied DESC)` for fast dashboard queries
- Soft delete or archival strategy after 6+ months (optional)

### 4. Background Task Execution
- Options:
  - **FastAPI `BackgroundTasks`**: Simple, good for <1000 tasks; use if syncing is not too frequent
  - **Celery + Redis**: Better for distributed polling; overkill for current scale
  - **APScheduler**: Lightweight scheduler within FastAPI app
  - **Recommended for now:** APScheduler (simplest, no external dependencies)

### 5. Email Label Management
- Assume emails arrive in "INBOX" or custom label
- For MVP: Search by keywords in subject/body
- Future: Ask students to create "Job Applications" label and search only that label

---

## Architecture

### Data Flow

```
[Student's Gmail Account]
         ↓
    Gmail API
    (OAuth 2.0)
         ↓
[REEP Backend - Worker]
    Poll every 15 min
         ↓
[Email Parser]
    Regex + spaCy NLP
         ↓
[Postgres: job_applications]
         ↓
[API Endpoints]
    GET /api/jobs/my-applications
    GET /api/jobs/metrics
         ↓
[Frontend Dashboard]
    Student: "Applied to 12 jobs"
    Mentor: "Student X applied to 5 jobs"
    Director: "80% of cohort applied to jobs"
```

### Directory Structure

```
apps/api-py/
  ├── app/
  │   ├── models/
  │   │   ├── __init__.py
  │   │   └── job_application.py          [NEW]
  │   ├── integrations/
  │   │   ├── __init__.py
  │   │   └── gmail.py                    [NEW]
  │   ├── routers/
  │   │   ├── jobs.py                     [NEW or UPDATE]
  │   │   └── auth.py                     [UPDATE: add Gmail OAuth callback]
  │   ├── background/
  │   │   ├── __init__.py
  │   │   └── gmail_sync.py               [NEW]
  │   ├── parsers/
  │   │   ├── __init__.py
  │   │   └── job_email_parser.py         [NEW]
  │   └── deps.py                         [UPDATE: add encryption/secrets]
  ├── migrations/
  │   └── alembic/
  │       └── versions/
  │           └── XXXX_add_job_applications.py  [NEW]
  └── tests/
      └── test_gmail_integration.py       [NEW]

apps/web/
  ├── src/app/features/
  │   ├── student/
  │   │   ├── jobs/
  │   │   │   ├── jobs.component.ts       [UPDATE or NEW]
  │   │   │   ├── jobs.component.html     [UPDATE or NEW]
  │   │   │   └── jobs.component.scss     [UPDATE or NEW]
  │   └── mentor/
  │       └── job-tracker/
  │           ├── job-tracker.component.ts [NEW]
  │           └── job-tracker.component.html [NEW]
```

---

## Implementation Steps

### Phase 1: Setup & OAuth (3–4 days)

#### Step 1.1: Database Schema
- [ ] Create Alembic migration for `job_applications` table
- [ ] Create Alembic migration to add `gmail_refresh_token`, `gmail_connected_at`, `gmail_last_synced_at` to `users` table
- [ ] Create SQLAlchemy ORM model: `JobApplication`

```python
# apps/api-py/app/models/job_application.py
from sqlalchemy import ForeignKey, String, DateTime, Enum
from sqlalchemy.orm import Mapped, mapped_column, relationship

class JobApplication(Base):
    __tablename__ = 'job_applications'
    
    id: Mapped[int] = mapped_column(primary_key=True)
    student_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    company_name: Mapped[str] = mapped_column(String(255), index=True)
    job_title: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(Enum('applied', 'rejected', 'offer', 'interview_scheduled', name='job_status'))
    date_applied: Mapped[datetime] = mapped_column(DateTime, index=True)
    email_subject: Mapped[str] = mapped_column(String(500))
    email_timestamp: Mapped[datetime] = mapped_column(DateTime)
    gmail_message_id: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    source: Mapped[str] = mapped_column(Enum('linkedin', 'indeed', 'company_site', 'email', name='job_source'))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
    
    student: Mapped[User] = relationship(back_populates='job_applications')
```

#### Step 1.2: Google OAuth Setup
- [ ] Create Google Cloud project & OAuth 2.0 credentials (OAuth 2.0 Client ID, type: Web)
- [ ] Add redirect URI: `https://<your-domain>/api/auth/gmail/callback`
- [ ] Store `GOOGLE_GMAIL_CLIENT_ID` and `GOOGLE_GMAIL_CLIENT_SECRET` in `.env`
- [ ] Create endpoint: `POST /api/auth/gmail/authorize` (returns Google OAuth URL)
- [ ] Create endpoint: `GET /api/auth/gmail/callback?code=...&state=...` (OAuth callback, stores refresh token)

#### Step 1.3: Encryption for Refresh Token
- [ ] Use Fernet (symmetric encryption) from `cryptography` library
- [ ] Store encryption key in `AUTH_SECRET` or new env var `GMAIL_ENCRYPTION_KEY`
- [ ] Encrypt refresh token before storing in DB; decrypt when using

```python
from cryptography.fernet import Fernet

# In app/config.py or app/deps.py
cipher = Fernet(GMAIL_ENCRYPTION_KEY.encode())

def encrypt_token(token: str) -> str:
    return cipher.encrypt(token.encode()).decode()

def decrypt_token(encrypted_token: str) -> str:
    return cipher.decrypt(encrypted_token.encode()).decode()
```

---

### Phase 2: Email Parsing & Polling (4–5 days)

#### Step 2.1: Job Email Parser
- [ ] Create `apps/api-py/app/parsers/job_email_parser.py`
- [ ] Implement regex patterns for LinkedIn, Indeed, company emails
- [ ] Implement spaCy NLP for entity extraction (company, job title)
- [ ] Return structured output: `ParsedJobApplication(company, job_title, status, date, confidence)`

```python
# apps/api-py/app/parsers/job_email_parser.py
import re
import spacy
from dataclasses import dataclass
from datetime import datetime

@dataclass
class ParsedJobApplication:
    company_name: str
    job_title: str
    status: str  # "applied", "rejected", "offer"
    date_applied: datetime
    source: str  # "linkedin", "indeed", "company_site", "email"
    confidence: float  # 0.0–1.0

class JobEmailParser:
    def __init__(self):
        self.nlp = spacy.load('en_core_web_sm')
    
    def parse(self, email_subject: str, email_body: str, email_timestamp: datetime) -> ParsedJobApplication | None:
        """
        Parse job application email.
        Returns ParsedJobApplication if recognized as job email, else None.
        """
        # Detect source
        source = self._detect_source(email_subject, email_body)
        
        if source == 'linkedin':
            return self._parse_linkedin(email_subject, email_body, email_timestamp)
        elif source == 'indeed':
            return self._parse_indeed(email_subject, email_body, email_timestamp)
        elif source == 'company_site':
            return self._parse_company_email(email_subject, email_body, email_timestamp)
        else:
            return None
    
    def _detect_source(self, subject: str, body: str) -> str | None:
        """Detect email source (LinkedIn, Indeed, etc.) from subject and body."""
        text = f"{subject} {body}".lower()
        
        if 'linkedin' in text:
            return 'linkedin'
        elif 'indeed' in text:
            return 'indeed'
        elif re.search(r'(careers|apply|application|job)', text):
            return 'company_site'
        return None
    
    def _parse_linkedin(self, subject: str, body: str, timestamp: datetime) -> ParsedJobApplication | None:
        """Parse LinkedIn job application email."""
        # Example: "You've applied to Software Engineer at Google"
        pattern = r"applied to (.+?) at (.+?)(?:\.|$)"
        match = re.search(pattern, subject, re.IGNORECASE)
        
        if match:
            job_title = match.group(1).strip()
            company_name = match.group(2).strip()
            
            # Determine status (simplified; could check body for rejection/offer)
            status = 'applied'
            if 'rejected' in body.lower():
                status = 'rejected'
            elif 'congratulations' in body.lower():
                status = 'offer'
            
            return ParsedJobApplication(
                company_name=company_name,
                job_title=job_title,
                status=status,
                date_applied=timestamp,
                source='linkedin',
                confidence=0.95
            )
        return None
    
    def _parse_indeed(self, subject: str, body: str, timestamp: datetime) -> ParsedJobApplication | None:
        """Parse Indeed job application email."""
        # Example: "Your application for Software Engineer at Google was received"
        pattern = r"application for (.+?) at (.+?) was"
        match = re.search(pattern, subject + " " + body, re.IGNORECASE)
        
        if match:
            job_title = match.group(1).strip()
            company_name = match.group(2).strip()
            
            status = 'applied'
            if 'rejected' in body.lower():
                status = 'rejected'
            
            return ParsedJobApplication(
                company_name=company_name,
                job_title=job_title,
                status=status,
                date_applied=timestamp,
                source='indeed',
                confidence=0.90
            )
        return None
    
    def _parse_company_email(self, subject: str, body: str, timestamp: datetime) -> ParsedJobApplication | None:
        """Parse company careers site email (generic)."""
        # Use spaCy NER to extract ORG and JOB TITLE
        doc = self.nlp(subject + " " + body[:500])  # Limit body to first 500 chars
        
        companies = [ent.text for ent in doc.ents if ent.label_ == 'ORG']
        company_name = companies[0] if companies else 'Unknown'
        
        # Extract job title from subject
        job_title_match = re.search(r'(Software Engineer|Data Analyst|Product Manager|Frontend|Backend)', subject, re.IGNORECASE)
        job_title = job_title_match.group(1) if job_title_match else 'Job Application'
        
        status = 'applied'
        if 'rejected' in body.lower():
            status = 'rejected'
        elif 'offer' in body.lower() or 'congratulations' in body.lower():
            status = 'offer'
        
        return ParsedJobApplication(
            company_name=company_name,
            job_title=job_title,
            status=status,
            date_applied=timestamp,
            source='company_site',
            confidence=0.70  # Lower confidence for generic parsing
        )
```

#### Step 2.2: Gmail Integration Module
- [ ] Create `apps/api-py/app/integrations/gmail.py`
- [ ] Implement Gmail API client initialization
- [ ] Implement email fetching logic
- [ ] Implement error handling (rate limits, auth errors)

```python
# apps/api-py/app/integrations/gmail.py
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.exceptions import RefreshError
import logging

class GmailIntegration:
    def __init__(self, student_id: int, encrypted_refresh_token: str, cipher):
        self.student_id = student_id
        self.refresh_token = cipher.decrypt(encrypted_refresh_token)
        self.service = None
        self.logger = logging.getLogger(__name__)
    
    def authenticate(self):
        """Authenticate using refresh token."""
        try:
            creds = Credentials(
                token=None,
                refresh_token=self.refresh_token,
                token_uri='https://oauth2.googleapis.com/token',
                client_id=os.getenv('GOOGLE_GMAIL_CLIENT_ID'),
                client_secret=os.getenv('GOOGLE_GMAIL_CLIENT_SECRET'),
            )
            creds.refresh(Request())
            self.service = build('gmail', 'v1', credentials=creds)
        except RefreshError as e:
            self.logger.error(f"Gmail auth failed for student {self.student_id}: {e}")
            raise
    
    def fetch_new_applications(self, since_timestamp: datetime | None = None) -> list[dict]:
        """
        Fetch emails matching job application keywords.
        Returns list of {subject, body, timestamp, message_id}.
        """
        if not self.service:
            self.authenticate()
        
        # Search query: look for job application keywords
        query = '(subject:application OR subject:applied OR subject:congratulations OR subject:offer OR subject:rejected)'
        
        try:
            results = self.service.users().messages().list(q=query, maxResults=100).execute()
            messages = results.get('messages', [])
            
            applications = []
            for msg in messages:
                msg_data = self._get_message_details(msg['id'])
                applications.append(msg_data)
            
            return applications
        
        except Exception as e:
            self.logger.error(f"Error fetching Gmail for student {self.student_id}: {e}")
            return []
    
    def _get_message_details(self, message_id: str) -> dict:
        """Fetch full message details from Gmail."""
        try:
            message = self.service.users().messages().get(id=message_id, format='full').execute()
            headers = message['payload']['headers']
            subject = next(h['value'] for h in headers if h['name'] == 'Subject')
            from_addr = next(h['value'] for h in headers if h['name'] == 'From')
            date_str = next(h['value'] for h in headers if h['name'] == 'Date')
            
            # Extract body (simplified; handle multipart if needed)
            body = ''
            if 'parts' in message['payload']:
                for part in message['payload']['parts']:
                    if part['mimeType'] == 'text/plain':
                        body = part['body'].get('data', '')
            else:
                body = message['payload']['body'].get('data', '')
            
            return {
                'message_id': message_id,
                'subject': subject,
                'body': body,
                'from': from_addr,
                'timestamp': email.utils.parsedate_to_datetime(date_str),
            }
        except Exception as e:
            self.logger.error(f"Error getting message {message_id}: {e}")
            return None
```

#### Step 2.3: Background Sync Worker
- [ ] Create `apps/api-py/app/background/gmail_sync.py`
- [ ] Use APScheduler to poll every 15 minutes
- [ ] For each student with Gmail connected, fetch and parse emails
- [ ] Store in DB, deduplicate by `gmail_message_id`

```python
# apps/api-py/app/background/gmail_sync.py
from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)

async def sync_gmail_for_student(db: AsyncSession, student_id: int):
    """Sync Gmail for a single student."""
    # 1. Get student with Gmail token
    student = await db.execute(
        select(User).where(User.id == student_id, User.gmail_refresh_token.isnot(None))
    )
    student = student.scalar_one_or_none()
    if not student:
        return
    
    try:
        # 2. Initialize Gmail integration
        gmail = GmailIntegration(student_id, student.gmail_refresh_token, cipher)
        
        # 3. Fetch emails
        emails = gmail.fetch_new_applications()
        
        # 4. Parse and store
        from app.parsers.job_email_parser import JobEmailParser
        parser = JobEmailParser()
        
        for email in emails:
            # Check for duplicates
            existing = await db.execute(
                select(JobApplication).where(
                    JobApplication.gmail_message_id == email['message_id']
                )
            )
            if existing.scalar_one_or_none():
                continue  # Already processed
            
            # Parse email
            parsed = parser.parse(email['subject'], email['body'], email['timestamp'])
            if not parsed:
                continue
            
            # Store in DB
            app = JobApplication(
                student_id=student_id,
                company_name=parsed.company_name,
                job_title=parsed.job_title,
                status=parsed.status,
                date_applied=parsed.date_applied,
                email_subject=email['subject'],
                email_timestamp=email['timestamp'],
                gmail_message_id=email['message_id'],
                source=parsed.source,
            )
            db.add(app)
        
        # Update sync timestamp
        student.gmail_last_synced_at = datetime.utcnow()
        await db.commit()
        logger.info(f"Synced Gmail for student {student_id}")
    
    except Exception as e:
        logger.error(f"Failed to sync Gmail for student {student_id}: {e}")

async def sync_all_gmail():
    """Sync Gmail for all connected students."""
    async with AsyncSession(engine) as db:
        students = await db.execute(
            select(User).where(User.gmail_refresh_token.isnot(None))
        )
        for student in students.scalars():
            await sync_gmail_for_student(db, student.id)

def start_gmail_sync_scheduler():
    """Start background scheduler for Gmail sync."""
    scheduler = BackgroundScheduler()
    scheduler.add_job(sync_all_gmail, 'interval', minutes=15)
    scheduler.start()
    logger.info("Gmail sync scheduler started")
```

#### Step 2.4: Register Scheduler in App Startup
- [ ] In `app/main.py`, call `start_gmail_sync_scheduler()` in the lifespan startup

```python
# apps/api-py/app/main.py
@app.get("/api/health")
async def health():
    return {"status": "ok"}

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    start_gmail_sync_scheduler()
    yield
    # Shutdown
    ...

app = FastAPI(lifespan=lifespan)
```

---

### Phase 3: API Endpoints (2–3 days)

#### Step 3.1: Job Routes
- [ ] `POST /api/jobs/connect-gmail` — Initiate OAuth flow
- [ ] `GET /api/jobs/my-applications` — List student's job applications
- [ ] `POST /api/jobs/sync-now` — Manually trigger sync
- [ ] `POST /api/jobs/{application_id}/update` — Manually correct parsed data (admin/student)
- [ ] `DELETE /api/jobs/{application_id}` — Mark as false positive

```python
# apps/api-py/app/routers/jobs.py
@router.get('/api/jobs/connect-gmail')
async def initiate_gmail_connect(session: SessionDep):
    """Return Google OAuth URL."""
    student = await require_student(session)
    if student.gmail_refresh_token:
        return {"status": "already_connected"}
    
    oauth_url = f"https://accounts.google.com/o/oauth2/v2/auth?" \
                f"client_id={GOOGLE_GMAIL_CLIENT_ID}" \
                f"&redirect_uri={REDIRECT_URI}" \
                f"&response_type=code" \
                f"&scope=https://www.googleapis.com/auth/gmail.readonly" \
                f"&state={generate_state_token(student.id)}"
    
    return {"oauth_url": oauth_url}

@router.get('/api/jobs/my-applications')
async def get_my_applications(session: SessionDep, db: DatabaseDep):
    """List student's job applications."""
    student = await require_student(session)
    
    apps = await db.execute(
        select(JobApplication)
        .where(JobApplication.student_id == student.id)
        .order_by(JobApplication.date_applied.desc())
    )
    
    return [
        {
            "id": app.id,
            "company": app.company_name,
            "job_title": app.job_title,
            "status": app.status,
            "date_applied": app.date_applied.isoformat(),
            "source": app.source,
        }
        for app in apps.scalars()
    ]

@router.post('/api/jobs/sync-now')
async def trigger_manual_sync(session: SessionDep, db: DatabaseDep):
    """Manually trigger Gmail sync for current student."""
    student = await require_student(session)
    
    if not student.gmail_refresh_token:
        raise HTTPException(status_code=400, detail="Gmail not connected")
    
    # Call sync function
    await sync_gmail_for_student(db, student.id)
    
    return {"status": "synced"}
```

---

### Phase 4: Frontend UI (3–4 days)

#### Step 4.1: Student Dashboard Component

```typescript
// apps/web/src/app/features/student/jobs/jobs.component.ts
import { Component, signal, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-jobs',
  templateUrl: './jobs.component.html',
  styleUrls: ['./jobs.component.scss'],
})
export class JobsComponent {
  applications = signal<JobApplication[]>([]);
  gmailConnected = signal(false);
  syncInProgress = signal(false);
  lastSyncedAt = signal<Date | null>(null);

  constructor(private http: HttpClient) {
    this.loadApplications();
    this.checkGmailStatus();
  }

  loadApplications() {
    this.http.get<JobApplication[]>('/api/jobs/my-applications', {
      credentials: 'include',
    }).subscribe((apps) => {
      this.applications.set(apps);
    });
  }

  checkGmailStatus() {
    this.http.get<{ connected: boolean; last_synced_at?: string }>(
      '/api/jobs/gmail-status',
      { credentials: 'include' }
    ).subscribe((status) => {
      this.gmailConnected.set(status.connected);
      if (status.last_synced_at) {
        this.lastSyncedAt.set(new Date(status.last_synced_at));
      }
    });
  }

  connectGmail() {
    this.http.get<{ oauth_url: string }>('/api/jobs/connect-gmail', {
      credentials: 'include',
    }).subscribe((response) => {
      window.location.href = response.oauth_url;
    });
  }

  syncNow() {
    this.syncInProgress.set(true);
    this.http.post('/api/jobs/sync-now', {}, {
      credentials: 'include',
    }).subscribe({
      next: () => {
        this.loadApplications();
        this.syncInProgress.set(false);
      },
      error: () => {
        this.syncInProgress.set(false);
      },
    });
  }
}
```

#### Step 4.2: HTML Template

```html
<!-- apps/web/src/app/features/student/jobs/jobs.component.html -->
<div class="jobs-container">
  <h2>Job Applications</h2>

  <!-- Gmail Connection Status -->
  @if (!gmailConnected()) {
    <div class="card" style="background: #fff3cd;">
      <p>Connect your Gmail to auto-track job applications</p>
      <button (click)="connectGmail()" class="btn btn-primary">
        Connect Gmail
      </button>
    </div>
  } @else {
    <div class="card" style="background: #d4edda;">
      <p>✓ Gmail connected | Last synced: {{ lastSyncedAt() | date }}</p>
      <button (click)="syncNow()" [disabled]="syncInProgress()" class="btn btn-sm">
        {{ syncInProgress() ? 'Syncing...' : 'Sync Now' }}
      </button>
    </div>
  }

  <!-- Applications List -->
  <div class="stats">
    <div class="stat-card">
      <div class="stat-value">{{ applications().length }}</div>
      <div class="stat-label">Total Applications</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">
        {{ applications().filter(a => a.status === 'offer').length }}
      </div>
      <div class="stat-label">Offers</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">
        {{ applications().filter(a => a.status === 'rejected').length }}
      </div>
      <div class="stat-label">Rejected</div>
    </div>
  </div>

  <!-- Timeline -->
  <div class="timeline">
    @for (app of applications(); track app.id) {
      <div class="timeline-item" [ngClass]="'status-' + app.status">
        <div class="timeline-date">{{ app.date_applied | date: 'MMM dd' }}</div>
        <div class="timeline-content">
          <h4>{{ app.job_title }}</h4>
          <p class="company">{{ app.company }}</p>
          <span class="badge" [ngClass]="'status-' + app.status">
            {{ app.status | titlecase }}
          </span>
          <p class="source">from {{ app.source | titlecase }}</p>
        </div>
      </div>
    }
  </div>

  @if (applications().length === 0) {
    <div class="empty-state">
      <p>No job applications yet. Connect Gmail and start applying!</p>
    </div>
  }
</div>
```

---

### Phase 5: Mentor & Director Views (2–3 days)

#### Step 5.1: Mentor Job Tracker
- [ ] `GET /api/mentor/students/{student_id}/applications` — See student's applications
- [ ] `GET /api/mentor/cohort/job-stats` — Cohort-level metrics

#### Step 5.2: Director Dashboard
- [ ] `GET /api/director/jobs/metrics` — Aggregate stats (% applied, avg apps, offer rate)
- [ ] Chart: Applications over time
- [ ] Chart: Top companies students applied to

---

## Testing Strategy

### Unit Tests
- [ ] `test_job_email_parser.py` — Test parsing of LinkedIn, Indeed, company emails
- [ ] `test_gmail_integration.py` — Mock Gmail API responses
- [ ] `test_job_routes.py` — Test API endpoints

### Integration Tests
- [ ] Test full flow: OAuth → Gmail fetch → Parse → Store → API retrieval
- [ ] Test duplicate deduplication
- [ ] Test error handling (Gmail API errors, invalid tokens)

### E2E Tests (Playwright)
- [ ] Student connects Gmail
- [ ] Student clicks "Sync Now"
- [ ] Dashboard updates with new applications
- [ ] Mentor views student's applications

---

## Success Criteria

### Functional
- [ ] Student can connect Gmail with OAuth (in <30 seconds)
- [ ] Gmail syncs every 15 minutes without user action
- [ ] Parser correctly identifies 85%+ of job applications
- [ ] Dashboard shows "Applied to X jobs" accurately
- [ ] Mentor can see student's job timeline
- [ ] Director can see cohort-level metrics

### Performance
- [ ] Gmail fetch + parse + store < 100ms per email
- [ ] Dashboard loads in <1 second
- [ ] No Gmail API rate limit errors (1M/day budget)

### Security
- [ ] Refresh tokens encrypted in DB
- [ ] No email bodies stored (only metadata)
- [ ] OAuth scope is read-only
- [ ] Student can revoke access anytime
- [ ] No violation of student data egress gate

### Reliability
- [ ] 99.5% uptime (handle Gmail API errors gracefully)
- [ ] Zero data loss (deduplication works)
- [ ] Graceful handling of token expiry (refresh automatically)

---

## Deliverables

1. **Database** — `job_applications` table, indexed, with 1M+ row capacity
2. **Backend** — OAuth flow, Gmail integration, email parser, background sync, API endpoints
3. **Frontend** — Student dashboard (connect Gmail, view applications), mentor tracker, director metrics
4. **Tests** — Unit, integration, E2E test suites (>80% coverage)
5. **Documentation** — API docs, setup guide, troubleshooting runbook
6. **Deployment** — Docker image includes requirements, migrations run at startup

---

## Timeline Estimate

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| 1. Setup & OAuth | 3–4 days | OAuth working, DB schema |
| 2. Parsing & Polling | 4–5 days | Email parser, sync worker |
| 3. API Endpoints | 2–3 days | All CRUD routes |
| 4. Student UI | 3–4 days | Dashboard, Gmail connect |
| 5. Mentor/Director Views | 2–3 days | Tracker, metrics |
| **Total** | **14–19 days** | Full feature ready for pilot |

---

## Future Enhancements (Phase 2+)

- [ ] Job posting integration: Link applications to REEP job board
- [ ] Outcome tracking: "Offer rate", "Interview rate"
- [ ] AI coaching: "Based on your skills, apply to these jobs"
- [ ] Resume suggestions: "Your resume doesn't mention X, which is required for this role"
- [ ] Interview reminders: "You have an interview with Google on Friday at 2 PM"
- [ ] Salary insights: Show salary ranges for applied jobs (aggregate data)
