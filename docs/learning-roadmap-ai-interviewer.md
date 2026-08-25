# Learning Roadmap: Building AI Interviewer for 1000 Students

A comprehensive guide to the skills, tools, and concepts needed to build REEP's AWS Nova + Transcribe + Polly interview system at scale.

---

## 1. Frontend (Angular 20 + WebSocket)

### Essentials
- **WebSocket API** — Real-time audio streaming (24 kHz PCM)
  - Topic: Bidirectional communication, message framing, reconnection logic
  - Learn: `WebSocket` browser API, backpressure handling, graceful close
  - Time: 2–3 days
  
- **Web Audio API** — Microphone capture, audio processing
  - Topic: `getUserMedia()`, `AudioContext`, real-time sampling at 24 kHz
  - Learn: Sample rate conversion, PCM encoding (signed 16-bit little-endian)
  - Time: 3–4 days

- **Angular Signals & RxJS** — State management for live interview UI
  - Topic: Reactive forms, streaming data, subscription cleanup
  - Learn: `effect()`, `computed()`, `async` pipe for real-time updates
  - Time: 2–3 days

- **Consent Flow UI** — Three-checkbox grant (live AI, store transcript, store audio)
  - Topic: Boolean state, conditional rendering, accessibility
  - Learn: WCAG 2.1, clear disclosure text, open/close modal with undo
  - Time: 1 day

### Advanced (Optional)
- **Audio Visualization** — Real-time waveform display during interview
  - Topic: Canvas, frequency analysis (FFT via AnalyserNode)
  - Time: 2–3 days

- **Offline Fallback** — Service Workers, IndexedDB for failed submissions
  - Topic: Cache strategies, retry on reconnect
  - Time: 2 days

**Total Frontend: 10–15 days**

---

## 2. Backend / API (FastAPI + Python 3.14)

### Essentials
- **FastAPI Basics** — HTTP routing, dependency injection, async handlers
  - Topic: `@app.post()`, `Request`/`Response`, `Depends()`, exception handling
  - Learn: Pydantic v2 validation, OpenAPI auto-docs
  - Time: 2–3 days

- **WebSocket in FastAPI** — Full-duplex audio relay
  - Topic: `WebSocketRoute`, `await ws.send_bytes()`, `await ws.receive_bytes()`
  - Learn: Connection lifecycle, error recovery, rate limiting
  - Time: 3–4 days

- **Interview State Machine** — Phase transitions (OPENING → PROBING → DEEP_DIVE → WRAP_UP)
  - Topic: Enum-based state, turn counter, phase-specific logic
  - Learn: Deterministic word-count gate (no model calls in the relay)
  - Code: `_advance_turn()` (single site for `response.create()`)
  - Time: 2–3 days

- **Integration with AWS SDKs**
  - **Transcribe** (STT) — `boto3.client('transcribe')`, start/stop jobs, polling
    - Time: 2 days
  - **Bedrock Nova** (LLM) — `boto3.client('bedrock-runtime')`, invoke model, stream responses
    - Time: 2 days
  - **Polly** (TTS) — `boto3.client('polly')`, synthesize speech to audio stream
    - Time: 1 day

### Database & ORM
- **SQLAlchemy 2.0 + async** — ORM for interview tables
  - Topic: `async_sessionmaker`, `select()`, relationships
  - Learn: `interview_sessions`, `interview_turns`, `interview_evaluations`, `interview_consents`
  - Time: 3–4 days

- **Alembic Migrations** — Schema versioning
  - Topic: `autogenerate`, custom migration scripts
  - Learn: Enum columns, FK constraints, pgvector extension
  - Time: 2 days

- **PostgreSQL + pgvector** — Knowledge base (optional grounding)
  - Topic: Full-text search + vector cosine similarity hybrid
  - Learn: `CREATE EXTENSION vector`, `embedding <=> :q` syntax
  - Time: 2 days

### Interview Logic
- **Turn Orchestration** — Relay that owns the turn
  - Topic: Word-count gate (deterministic, no API calls), response.create() once per turn
  - Learn: Avoiding duplicate questions, handling empty/no-response cases
  - Time: 2–3 days

- **Evaluation Scoring** — JSON scorecard at wrap-up
  - Topic: Structured output, nullable scores vs. zero, grading rubric
  - Learn: Defensive JSON parsing, robust against LLM hallucination
  - Time: 2 days

- **Consent & Data Protection**
  - Topic: Row-level checks before interview starts
  - Learn: `interview_consents` table, close 4013/4014 WebSocket codes
  - Time: 1 day

### Error Handling & Resilience
- **Fire-and-Forget Logging** — Async turn persistence
  - Topic: Tasks that fail silently don't kill live calls
  - Learn: Background task queues, fallback strategies
  - Time: 1–2 days

- **Graceful Shutdown** — Three idempotent closers (relay finalizer, router finally, retention sweep)
  - Topic: Context managers, database atomicity
  - Time: 1 day

**Total Backend: 25–35 days**

---

## 3. AWS Services & Cloud Infrastructure

### Transcribe (Speech-to-Text)
- **Async Job API** — Start transcription job, wait for completion, retrieve transcript
  - Topic: Job status polling, handling long audio files
  - Learn: `start_transcription_job()`, `get_transcription_job()`, retry logic
  - Time: 2 days

- **Real-Time Transcribe** (Optional, more complex)
  - Topic: Streaming API with WebSocket
  - Learn: Lower latency than async jobs
  - Time: 2 days (if pursuing)

### Bedrock (LLM via Nova)
- **Model Invocation** — Prompt engineering for interview scenarios
  - Topic: System prompts, few-shot examples, JSON output mode
  - Learn: Token counting, rate limits, cost estimation
  - Time: 3–4 days

- **Streaming Responses** — Get LLM output token-by-token
  - Topic: `invoke_model_with_response_stream()`, buffering partial text
  - Time: 1–2 days

- **Retry Logic & Backoff** — Handling rate limits and transient errors
  - Topic: Exponential backoff, jitter
  - Time: 1 day

### Polly (Text-to-Speech)
- **Synthesize Speech** — `synthesize_speech()` API
  - Topic: Voice selection, SSML markup for emphasis
  - Learn: MP3/PCM output formats, streaming
  - Time: 1–2 days

### IAM & Security
- **IAM Policies** — Least-privilege access for Transcribe, Bedrock, Polly
  - Topic: `Action`, `Resource`, `Condition` statements
  - Learn: Service role for EC2/ECS, inline policies
  - Time: 2–3 days

- **Secrets Management** — API keys, database credentials
  - Topic: AWS Secrets Manager or `.env` with validation
  - Learn: Rotation, access logs
  - Time: 1 day

### Deployment Options (Pick One)

#### Option A: EC2 (Simple, Single-Machine)
- **EC2 Setup** — Launch instance, security groups, SSH key pairs
  - Topic: Instance types (t3 for dev, c5 for prod), networking
  - Learn: AMI selection, volume management
  - Time: 2 days

- **Docker** — Containerize FastAPI + Nginx
  - Topic: `Dockerfile`, `docker-compose`, image layers
  - Learn: `.dockerignore`, caching, multi-stage builds
  - Time: 2–3 days

- **Nginx Reverse Proxy** — Route `/api` to backend, serve frontend
  - Topic: Upstream blocks, SSL/TLS termination, gzip
  - Learn: Location blocks, proxy headers
  - Time: 2 days

#### Option B: ECS + RDS (Scalable, Managed)
- **ECS Fargate** — Containerized workloads without managing servers
  - Topic: Task definitions, service scaling, load balancer integration
  - Learn: CloudFormation/Terraform, health checks
  - Time: 3–4 days

- **RDS PostgreSQL** — Managed database
  - Topic: Multi-AZ, backup, parameter groups
  - Learn: Connection pooling (pgBouncer), monitoring
  - Time: 2–3 days

- **CloudFront** — CDN for frontend assets
  - Topic: Distribution, cache behaviors, invalidation
  - Time: 1 day

#### Option C: Kubernetes (EKS) — Advanced
- **Kubernetes Basics** — Pods, Services, Deployments
  - Topic: YAML manifests, rolling updates, health probes
  - Time: 5–7 days (significant learning curve)

**Total AWS: 20–30 days (depending on deployment path chosen)**

---

## 4. AI/ML Concepts

### Natural Language Processing (NLP) Fundamentals
- **Tokenization** — How LLMs break text into tokens
  - Topic: Subword tokenization, BPE, byte-pair encoding
  - Learn: Token counting for cost estimation
  - Time: 1 day

- **Prompt Engineering** — Crafting instructions for Nova
  - Topic: System prompts, role-playing, examples (few-shot), chain-of-thought
  - Learn: Testing with the console, iterating on rubrics
  - Time: 3–5 days

- **Evaluation Metrics** — Grading consistency across interviews
  - Topic: Inter-rater reliability, scoring rubrics
  - Learn: Designing fair evaluation criteria
  - Time: 2–3 days

### Speech AI
- **Speech Recognition (ASR)** — How Transcribe converts audio to text
  - Topic: Acoustic models, language models, decoding
  - Learn: Confidence scores, word-level timestamps, multilingual support
  - Time: 1–2 days

- **Text-to-Speech (TTS)** — How Polly creates voices
  - Topic: Prosody, phoneme alignment, voice cloning
  - Learn: SSML markup for natural-sounding responses
  - Time: 1–2 days

### Embeddings & Vector Search (Optional)
- **Word Embeddings** — Turning text into vectors
  - Topic: Word2Vec, FastText, transformer embeddings
  - Learn: Cosine similarity, dimensionality
  - Time: 1–2 days

- **Semantic Search** — Hybrid full-text + vector similarity
  - Topic: BM25, vector distance metrics
  - Learn: pgvector queries, relevance ranking
  - Time: 2 days

**Total AI/ML: 15–20 days**

---

## 5. Interview Design & Psychology

### Behavioral Interview Theory
- **STAR Method** — Structured interviewing (Situation, Task, Action, Result)
  - Topic: Evaluating competency through examples
  - Learn: Designing open-ended questions, avoiding bias
  - Time: 1–2 days

- **Competency Frameworks** — What skills to test
  - Topic: HR, Digital Marketing, Business Analytics, Financial Analytics specializations
  - Learn: Role-specific rubrics, weighting criteria
  - Time: 2–3 days

### Interview Flow & Persona
- **Opening Beat** — Self-introduction, setting tone
  - Topic: Building rapport, reducing anxiety
  - Time: 1 day

- **Probing Beat** — Clarifying student's experience
  - Topic: Follow-up questions, handling silence
  - Time: 1 day

- **Deep Dive** — Technical/scenario-based questions
  - Topic: Complexity escalation
  - Time: 1 day

- **Wrap-Up** — Closing with verdict and next steps
  - Topic: Fairness, transparency
  - Time: 1 day

- **Bias Mitigation** — Reducing gender, age, accent bias
  - Topic: Blind evaluation, diverse question pools
  - Time: 1–2 days

**Total Interview Design: 7–10 days**

---

## 6. DevOps & Monitoring

### Logging & Debugging
- **Structured Logging** — JSON logs with request IDs, user context
  - Topic: Log levels, centralized log aggregation
  - Learn: CloudWatch Logs, ELK stack alternatives
  - Time: 2 days

- **Distributed Tracing** — Following a request across services
  - Topic: OpenTelemetry, trace context propagation
  - Learn: X-Ray (AWS), Jaeger
  - Time: 2 days

### Monitoring & Alerting
- **Metrics** — Interview duration, API latency, error rates
  - Topic: Prometheus, CloudWatch dashboards
  - Learn: Custom metrics, thresholds, alerts
  - Time: 2–3 days

- **Health Checks** — Is Transcribe working? Is Polly working?
  - Topic: `/health`, dependency checks
  - Time: 1 day

### Database Optimization
- **Query Performance** — Analyzing slow queries
  - Topic: `EXPLAIN ANALYZE`, indexing strategies
  - Learn: N+1 problems, connection pooling
  - Time: 2–3 days

- **Backup & Recovery** — Point-in-time restore
  - Topic: RDS snapshots, WAL archiving
  - Time: 1 day

### CI/CD Pipeline
- **GitHub Actions** — Automated testing & deployment
  - Topic: Workflows, matrix builds, secrets management
  - Learn: Testing on every PR, deploying on merge to main
  - Time: 2–3 days

- **Automated Testing**
  - Unit tests (pytest for Python, Jasmine for Angular)
  - Integration tests (full interview flow)
  - End-to-end tests (browser automation with Playwright)
  - Time: 5–7 days

**Total DevOps: 18–25 days**

---

## 7. Security & Compliance

### Data Protection
- **Student Data Egress Gate** — `student_data_egress_allowed()`
  - Topic: Sensitive data classification, remote API restrictions
  - Learn: When to allow/block external LLM calls with PII
  - Time: 1 day

- **Encryption** — At rest (database) and in transit (TLS/HTTPS)
  - Topic: AES-256, RSA key management
  - Learn: AWS KMS, certificate management
  - Time: 2 days

- **SQL Injection & XSS Prevention**
  - Topic: Parameterized queries (SQLAlchemy ORM), Angular sanitization
  - Time: 1 day

### Authentication & Authorization
- **Google OAuth 2.0** — Google-only sign-in
  - Topic: OIDC flow, ID tokens, JWT validation
  - Learn: Nonce, state cookie, JWKS verification
  - Time: 2 days

- **Session Management** — httpOnly cookies, CSRF protection
  - Topic: HS256 JWT signing with `AUTH_SECRET`
  - Learn: Token expiry, refresh strategies
  - Time: 1 day

- **Role-Based Access Control (RBAC)** — Student, Mentor, Director, Admin
  - Topic: Row-level security (mentor sees only their students)
  - Learn: Authorization middleware
  - Time: 1–2 days

### Compliance & Privacy
- **GDPR/CCPA** — Student data retention and deletion
  - Topic: Right to be forgotten, data minimization
  - Learn: 180-day retention clock, audit logs
  - Time: 1–2 days

- **Consent Management** — Recording consent for audio/transcripts
  - Topic: Versioned consent records, revocation
  - Learn: `interview_consents` table structure
  - Time: 1 day

- **Audit Logging** — Who accessed what and when
  - Topic: Immutable logs, alerting on suspicious access
  - Time: 1 day

**Total Security: 12–16 days**

---

## 8. Scale & Performance (1000 Students)

### Load Estimation
- **Concurrent Interviews** — How many at once?
  - Assumption: 5–10 simultaneous interviews (staggered scheduling)
  - Peak load: 10 students × 3–5 API calls per turn = 30–50 req/sec
  - Time: 1 day (analysis)

### Database Scaling
- **Read Replicas** — Mentor/Director dashboards querying while interviews run
  - Topic: RDS multi-region, cross-region replication
  - Time: 1–2 days

- **Partitioning** — Sharding interview data by student ID or date
  - Topic: Range/hash partitioning
  - Time: 2 days (optional unless >1M rows)

### API Scaling
- **Horizontal Scaling** — Multiple API instances behind a load balancer
  - Topic: Session affinity, stateless design
  - Time: 1–2 days

- **Caching** — Redis for interview state, KnowledgeBase queries
  - Topic: Cache invalidation, TTL strategies
  - Time: 2 days (optional)

- **Rate Limiting** — Prevent abuse, manage AWS API quotas
  - Topic: Token bucket algorithm, per-student limits
  - Time: 1 day

### Cost Optimization
- **AWS Pricing Models** — On-demand vs. Reserved Instances vs. Spot
  - Topic: Transcribe/Bedrock/Polly per-unit costs
  - Learn: Cost calculator, budget alerts
  - Time: 1 day

- **Resource Sizing** — Right-sizing compute, storage, bandwidth
  - Topic: CloudWatch metrics, capacity planning
  - Time: 1–2 days

**Total Scale: 11–15 days**

---

## 9. Specialized Topics (Pick as Needed)

### Advanced WebSocket
- **Binary Framing** — Efficient audio packet encoding
  - Topic: WebSocket opcodes, masking
  - Time: 1 day

- **Connection Pooling** — Managing 1000 concurrent WebSocket clients
  - Topic: Memory per connection, graceful degradation
  - Time: 1–2 days

### Advanced Async Programming
- **Python asyncio** — Concurrency model, event loop
  - Topic: `asyncio.gather()`, `asyncio.wait()`, context vars
  - Learn: Avoiding blocking calls, debugging deadlocks
  - Time: 2–3 days

### Cloud Architecture Patterns
- **Microservices vs. Monolith** — Is REEP one service or many?
  - Topic: Trade-offs for your scale (1000 students is small)
  - Time: 1 day (decision)

- **Event-Driven Architecture** — Webhooks for interview completion
  - Topic: Message queues (SQS), event buses (EventBridge)
  - Time: 2 days (optional)

### Observability Deep Dive
- **APM (Application Performance Monitoring)** — Datadog, New Relic, X-Ray
  - Topic: Flame graphs, profiling, identifying bottlenecks
  - Time: 2–3 days

---

## 10. Soft Skills & Product Sense

### Requirement Gathering
- **Stakeholder Interviews** — What do mentors/directors need?
  - Topic: User stories, acceptance criteria
  - Time: 2–3 days

### A/B Testing & Analytics
- **Interview Analytics** — Tracking pass rates, question effectiveness
  - Topic: Cohort analysis, experiment design
  - Time: 2 days

### Documentation
- **API Documentation** — OpenAPI/Swagger auto-generated from FastAPI
  - Topic: Clear examples, error codes
  - Time: 1 day

- **Runbooks** — "What to do if X breaks?"
  - Topic: Incident response, recovery procedures
  - Time: 1–2 days

---

## Learning Path by Timeline

### **Month 1: Foundations** (~30 days)
1. Frontend WebSocket + Web Audio (5 days)
2. Backend FastAPI + async (5 days)
3. Interview state machine logic (3 days)
4. AWS Transcribe/Bedrock/Polly basics (5 days)
5. Interview design & evaluation rubrics (3 days)
6. Setup: Docker, local dev environment (2 days)
7. Basic security: OAuth, password hashing (2 days)

**Deliverable:** Local prototype with mock audio, working state machine, basic AWS integration.

---

### **Month 2: Integration & MVP** (~30 days)
1. SQLAlchemy models for interview tables (3 days)
2. WebSocket full-duplex relay (5 days)
3. Transcribe + Nova + Polly end-to-end (5 days)
4. Consent flow, data protection (2 days)
5. Test suite (pytest, integration tests) (4 days)
6. Logging, error handling, resilience (3 days)
7. Deploy to EC2 (simple path) (2 days)
8. Documentation (1 day)

**Deliverable:** MVP running on AWS, 10 students tested, basic monitoring.

---

### **Month 3: Scale & Polish** (~30 days)
1. Database optimization (queries, indexes) (3 days)
2. CI/CD pipeline (GitHub Actions) (3 days)
3. Monitoring & alerting (CloudWatch) (2 days)
4. Distributed tracing (1 day)
5. Load testing (simulating 100 concurrent interviews) (3 days)
6. Cost optimization, reserved capacity (2 days)
7. Mentor/director dashboards (4 days)
8. Audit logging, compliance (2 days)
9. Runbooks, incident response (2 days)
10. User acceptance testing (UAT) with real students (3 days)

**Deliverable:** Production-ready system for 1000 students, SLA targets met, monitored.

---

## Learning Resources by Topic

### **Frontend (Angular 20, WebSocket, Web Audio)**
- Angular Docs: https://angular.dev
- MDN Web Audio API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
- WebSocket Protocol: RFC 6455
- Book: "Web Audio API" by Boris Smus

### **Backend (FastAPI, SQLAlchemy, Async Python)**
- FastAPI Docs: https://fastapi.tiangolo.com
- SQLAlchemy 2.0 Docs: https://docs.sqlalchemy.org/
- Real Python: "Async IO in Python" article
- Arjan Codes (YouTube): FastAPI deep dives

### **AWS Services**
- AWS Transcribe Docs: https://docs.aws.amazon.com/transcribe/
- AWS Bedrock Docs: https://docs.aws.amazon.com/bedrock/
- AWS Polly Docs: https://docs.aws.amazon.com/polly/
- Tutorials Dojo (paid courses for AWS certifications)

### **NLP & Interview Design**
- Hugging Face Course: https://huggingface.co/course
- Book: "Designing Interviews" by Paul Falcone
- OpenAI Prompt Engineering Guide: https://platform.openai.com/docs/guides/prompt-engineering

### **DevOps & Deployment**
- Docker Docs: https://docs.docker.com
- Kubernetes Basics: https://kubernetes.io/docs/ (if choosing EKS path)
- GitHub Actions Docs: https://docs.github.com/en/actions
- Linux Academy / Linux Foundation courses

### **Security & Privacy**
- OWASP Top 10: https://owasp.org/www-project-top-ten/
- AWS Security Best Practices: https://aws.amazon.com/architecture/security-identity-compliance/
- Book: "The Web Application Security Handbook"

---

## Success Metrics

### Knowledge Checkpoints
- [ ] Can build a WebSocket relay that streams audio in real-time
- [ ] Can invoke AWS services (Transcribe, Bedrock, Polly) and handle errors
- [ ] Can design a deterministic state machine for interview flow
- [ ] Can write an evaluation rubric and implement scoring
- [ ] Can deploy to EC2 and scale horizontally
- [ ] Can monitor and debug live interviews in production

### Code Quality
- Unit test coverage > 70%
- End-to-end test for full interview flow
- Zero production outages in first 100 interviews
- <200ms median latency per turn
- <$2 cost per interview (AWS services only)

### User Satisfaction
- 95%+ of students successfully complete interviews
- <1% retry rate due to technical failure
- Mentor feedback: "Interviews are realistic and fair"
- Director feedback: "System is easy to operate and scale"

---

## Time Estimate Summary

| Category | Days | Notes |
|----------|------|-------|
| Frontend | 10–15 | WebSocket, Web Audio, Angular signals |
| Backend | 25–35 | FastAPI, SQLAlchemy, interview logic |
| AWS Services | 20–30 | Transcribe, Bedrock, Polly, EC2/ECS, IAM |
| AI/ML | 15–20 | NLP, speech AI, evaluation design |
| Interview Design | 7–10 | STAR, competency frameworks, bias mitigation |
| DevOps | 18–25 | Logging, monitoring, CI/CD, testing |
| Security | 12–16 | Auth, encryption, compliance, RBAC |
| Scale | 11–15 | Load testing, caching, cost optimization |
| Soft Skills | 5–8 | Documentation, requirements, A/B testing |
| **TOTAL** | **123–174 days** | ~6–8.5 months, part-time learning |

**Realistic timeline:** 3–4 months for a team of 2–3 engineers with prior experience.

---

## Next Steps

1. **Pick your deployment path** (EC2 simple vs. ECS managed vs. Kubernetes)
2. **Prioritize by business value** (MVP first, then scale)
3. **Setup local dev environment** (Docker, `.env` file, database)
4. **Write one feature end-to-end** (e.g., single turn: audio in → Transcribe → Nova → Polly → audio out)
5. **Test with real students** (5–10 pilot users before full rollout)
6. **Monitor & iterate** (latency, cost, user feedback)

Good luck! 🚀
