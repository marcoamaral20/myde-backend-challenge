# Technical Backlog

This document defines the official execution backlog for the Myde backend challenge.

The plan prioritizes a short delivery window, high technical evaluation value, and a simple architecture that still demonstrates security, idempotency, tenant isolation, asynchronous processing, resilience and observability.

## Technical Stack

| Area | Technology |
|------|------------|
| Runtime | Node.js |
| Language | TypeScript |
| HTTP framework | Fastify |
| Database | PostgreSQL |
| ORM | Drizzle ORM |
| Queue | BullMQ |
| Queue backend | Redis |
| Validation | Zod |
| Logger | Pino |
| Tests | Vitest |
| AI integration | OpenAI SDK behind AIProvider interface |
| Package manager | npm |

## Priority Levels

| Priority | Meaning |
|----------|---------|
| P0 | Mandatory for the challenge delivery |
| P1 | Important if the P0 baseline is stable |
| P2 | Differentiator, only if there is enough time |

## Milestone 1 - Project Foundation

### 1. Initial Modular Structure

**Priority:** P0

**Objective:** Create the initial project structure with `domain`, `modules`, `infra`, `shared`, and separate HTTP and worker entrypoints.

**Justification:** Clear boundaries make the solution easier to reason about and defend in a technical interview. They also prevent direct coupling between business logic, Fastify, BullMQ, OpenAI and PostgreSQL.

**Dependencies:** None.

**Estimate:** 2 hours.

**Acceptance Criteria:**

- The project compiles.
- The folder structure follows the architecture defined in `docs/architecture.md`.
- HTTP and worker entrypoints are planned separately.
- No business logic is placed directly inside infrastructure adapters.

### 2. Environment Configuration Validation

**Priority:** P0

**Objective:** Validate required environment variables at startup using Zod.

**Justification:** Fail-fast configuration prevents hidden runtime failures and makes local execution predictable.

**Dependencies:** Item 1.

**Estimate:** 2 hours.

**Acceptance Criteria:**

- The application fails at startup when required variables are missing.
- `OPENAI_API_KEY` is required only when `AI_PROVIDER=openai`.
- The application starts without an OpenAI key when `AI_PROVIDER=stub`.
- Environment validation is centralized and typed.

### 3. Structured Logger Base

**Priority:** P0

**Objective:** Add a structured logger using Pino with consistent fields for request and job tracing.

**Justification:** Observability is an explicit evaluation criterion and is essential for debugging webhook and worker flows.

**Dependencies:** Item 1.

**Estimate:** 1.5 hours.

**Acceptance Criteria:**

- Logs are structured as JSON.
- Logs support fields such as `tenantId`, `conversationId`, `messageId`, `metaMessageId`, `replyToMessageId`, `jobId`, `correlationId` and `event`.
- A correlation id can be generated in the webhook path and propagated to the worker path.

### 4. Database Schema, Migrations and Seed

**Priority:** P0

**Objective:** Implement the Drizzle schema and migrations for `tenants`, `contacts`, `conversations` and `messages`, plus seed data for a demo tenant.

**Justification:** Persistence, idempotency and tenant isolation all depend on the database model.

**Dependencies:** Item 2.

**Estimate:** 5 hours.

**Acceptance Criteria:**

- `tenants.phoneNumberId` is unique.
- `contacts` has a unique constraint on `(tenantId, waId)`.
- `messages` contains `tenantId`, `conversationId`, `contactId`, `metaMessageId`, `replyToMessageId`, `direction`, `role`, `content`, `processingStatus`, `failureReason`, `rawPayload`, `receivedAt`, `processedAt`, `sentAt`, `createdAt` and `updatedAt`.
- `messages` has a unique constraint on `(tenantId, metaMessageId)` when `metaMessageId` exists.
- `messages` has a unique constraint on `(tenantId, replyToMessageId)` when `replyToMessageId` exists.
- Seed data creates at least one tenant with a known `phoneNumberId`.

### Suggested Commits

```txt
chore: setup modular project structure
chore: validate environment configuration
chore: add structured logger
feat: add database schema and initial migrations
```

## Milestone 2 - Secure and Persistent Webhook

### 5. Webhook Verification Endpoint

**Priority:** P0

**Objective:** Implement `GET /webhook` for the Meta verification handshake.

**Justification:** This is a mandatory Meta webhook requirement and a low-complexity early win.

**Dependencies:** Item 2.

**Estimate:** 1 hour.

**Acceptance Criteria:**

- The endpoint reads `hub.mode`, `hub.verify_token` and `hub.challenge`.
- A valid token returns the challenge.
- An invalid token returns `403`.

### 6. Raw Body and HMAC Signature Validation

**Priority:** P0

**Objective:** Validate `X-Hub-Signature-256` using HMAC-SHA256 over the raw request body and `META_APP_SECRET`.

**Justification:** Security is a high-weight evaluation criterion, and signature validation must use the raw body to be correct.

**Dependencies:** Item 5.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- Valid signatures are accepted.
- Invalid signatures return `401`.
- Signature comparison uses `crypto.timingSafeEqual`.
- Signature validation is implemented in a dedicated service.

### 7. Isolated Meta Payload Parser

**Priority:** P0

**Objective:** Create a parser that extracts `phoneNumberId`, `messageId`, `from`, `text` and `timestamp` from supported Meta payloads.

**Justification:** Keeping parsing isolated makes the controller simple and the payload behavior easy to test.

**Dependencies:** Item 6.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- Text messages are parsed.
- Status events are ignored.
- Payloads without messages are acknowledged safely.
- Unknown payload shapes do not crash the application.
- The initial limitations are documented.

### 8. Receive Inbound Message Use Case

**Priority:** P0

**Objective:** Resolve tenant, create or reuse contact, create or reuse conversation, and save inbound messages with `processingStatus = received`.

**Justification:** This is the core business use case behind the webhook.

**Dependencies:** Items 4 and 7.

**Estimate:** 5 hours.

**Acceptance Criteria:**

- Tenant is resolved by `phoneNumberId`.
- Contact is created or reused by `(tenantId, waId)`.
- An active conversation is created or reused for the contact.
- Inbound messages are persisted with `processingStatus = received`.
- The use case returns whether the message is new or duplicated.

### 9. Inbound Idempotency

**Priority:** P0

**Objective:** Guarantee duplicate webhook deliveries do not create duplicate inbound messages or duplicate processing.

**Justification:** Meta may redeliver the same webhook. Idempotency must be guaranteed at the database level to remain safe under concurrency.

**Dependencies:** Item 8.

**Estimate:** 4 hours.

**Acceptance Criteria:**

- Repeated `metaMessageId` for the same tenant does not create a second message.
- Existing messages in `queued`, `processing`, `reply_generated` or `sent` are not enqueued again.
- Existing messages in `received` or `failed` may be retried.
- The system logs `message_already_processed` when appropriate.

### 10. Complete `POST /webhook` Handler

**Priority:** P0

**Objective:** Validate signature, parse payload, persist inbound messages, and return `200` quickly without calling OpenAI.

**Justification:** The webhook must be secure, fast and asynchronous.

**Dependencies:** Items 6, 7, 8 and 9.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- The handler does not call OpenAI directly.
- Valid inbound messages are persisted.
- Unknown tenants are logged and acknowledged safely.
- The webhook responds quickly.
- Invalid signatures are rejected before business processing.

### Suggested Commits

```txt
feat: implement webhook verification endpoint
feat: validate meta webhook signatures
feat: parse inbound meta webhook payloads
feat: persist inbound whatsapp messages
feat: add idempotent inbound webhook handling
```

## Milestone 3 - Queue, Worker and Asynchronous Reply Flow

### 11. BullMQ Queue Setup

**Priority:** P0

**Objective:** Configure BullMQ with Redis, job payloads, retries, backoff and idempotent job ids.

**Justification:** Asynchronous processing is central to the challenge and must be real, not simulated inside the request handler.

**Dependencies:** Item 10.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- The queue uses Redis through BullMQ.
- Job payload includes `tenantId`, `conversationId`, `messageId` and `correlationId`.
- Job id uses a deterministic key such as `tenantId:messageId`.
- Jobs use retry attempts and exponential backoff.
- Worker concurrency starts with a conservative value.

### 12. Webhook to Queue Integration

**Priority:** P0

**Objective:** Enqueue a background job only after the inbound message is persisted, then update status from `received` to `queued`.

**Justification:** This keeps the webhook fast while preserving recoverability if enqueue fails.

**Dependencies:** Item 11.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- A new inbound message is persisted before enqueue.
- Successful enqueue updates the inbound message to `queued`.
- Enqueue failure keeps the inbound message as `received`.
- Enqueue failure logs `job_enqueue_failed`.
- The webhook still returns `200` after persistence if enqueue fails.

### 13. Worker Lifecycle

**Priority:** P0

**Objective:** Implement the worker flow that loads the inbound message, marks it as `processing`, generates a reply, persists outbound, sends to Meta mock and marks the inbound as `sent`.

**Justification:** This is the main end-to-end flow and the strongest proof of asynchronous architecture.

**Dependencies:** Item 12.

**Estimate:** 6 hours.

**Acceptance Criteria:**

- The worker runs outside the webhook handler.
- The inbound message lifecycle supports `received`, `queued`, `processing`, `reply_generated`, `sent` and `failed`.
- The worker supports graceful shutdown.
- Failure after retries records `failureReason`.
- The worker logs `worker_started`, `worker_failed` and `message_processing_completed`.

### 14. Outbound Idempotency in the Worker

**Priority:** P0

**Objective:** Prevent duplicate AI replies and duplicate Meta sends during retries or partial failures.

**Justification:** Worker retries are required, but retries must not send duplicate WhatsApp messages.

**Dependencies:** Item 13.

**Estimate:** 4 hours.

**Acceptance Criteria:**

- `replyToMessageId` is used as the logical idempotency key.
- The worker does not generate a second outbound reply if one already exists.
- If an outbound reply exists but was not sent, the worker reuses it.
- If an outbound reply was already sent, the worker finishes without sending again.
- The database enforces a unique reply per inbound message.

### 15. AI Provider Interface and Stub Provider

**Priority:** P0

**Objective:** Define `AIProvider` and implement a stub provider for local execution and tests.

**Justification:** The business flow should not be coupled directly to OpenAI, and the project must be runnable without a real API key.

**Dependencies:** Item 13.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- `AIProvider` exposes a method such as `generateReply(input): Promise<string>`.
- `AI_PROVIDER=stub` uses the stub provider.
- The application starts without `OPENAI_API_KEY` when using the stub.
- Worker code depends on the interface, not directly on the OpenAI SDK.

### 16. Knowledge Base Service and Prompt Rules

**Priority:** P0

**Objective:** Load local knowledge-base files and define prompt rules that keep answers grounded.

**Justification:** The AI response must be based on the provided knowledge base and must not invent information.

**Dependencies:** Item 15.

**Estimate:** 4 hours.

**Acceptance Criteria:**

- Knowledge-base files are loaded from `knowledge-base/`.
- Conversation history sent to AI is limited.
- Prompt rules instruct the model to answer only from the knowledge base.
- Missing information produces an explicit "I do not know" style fallback.
- Answers are short and suitable for WhatsApp.

### 17. Meta Client for Outbound Replies

**Priority:** P0

**Objective:** Implement a Meta client that sends outbound replies to the mock endpoint.

**Justification:** The challenge expects the backend to send replies through the Meta API mock.

**Dependencies:** Items 13 and 16.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- The client sends `POST /{phoneNumberId}/messages` to `META_API_BASE_URL`.
- HTTP details are isolated from the worker use case.
- Send failures are logged with context.
- Send failures are retryable by the queue.

### Suggested Commits

```txt
feat: add async message processing queue
feat: process inbound messages with worker
feat: add ai provider abstraction
feat: load knowledge base for ai context
feat: send outbound replies to meta mock
```

## Milestone 4 - REST API, Tests and Delivery

### 18. REST Tenant Middleware

**Priority:** P0

**Objective:** Resolve the REST API tenant using the `x-tenant-id` request header.

**Justification:** Tenant isolation is an explicit requirement, even with simplified authentication.

**Dependencies:** Item 4.

**Estimate:** 2 hours.

**Acceptance Criteria:**

- Missing `x-tenant-id` is rejected.
- Invalid `x-tenant-id` is rejected.
- Valid tenant id is attached to the request context.
- The limitation of this simplified authentication model is documented.

### 19. `GET /conversations`

**Priority:** P0

**Objective:** List conversations for the authenticated tenant.

**Justification:** This is one of the required REST endpoints.

**Dependencies:** Item 18.

**Estimate:** 2 hours.

**Acceptance Criteria:**

- Only conversations from the current tenant are returned.
- The endpoint does not expose data from other tenants.
- Response ordering is deterministic.

### 20. `GET /conversations/:id/messages`

**Priority:** P0

**Objective:** List messages for a specific conversation owned by the authenticated tenant.

**Justification:** This is one of the required REST endpoints and a key tenant isolation check.

**Dependencies:** Item 19.

**Estimate:** 2 hours.

**Acceptance Criteria:**

- Messages are filtered by `tenantId` and `conversationId`.
- A conversation from another tenant is not revealed.
- Messages are ordered deterministically, preferably by `receivedAt` and then `createdAt`.

### 21. Mandatory Business Tests

**Priority:** P0

**Objective:** Add at least five tests covering the most important business and security behavior.

**Justification:** Tests are explicitly required and represent 10 percent of the evaluation.

**Dependencies:** Items 6, 9 and 20.

**Estimate:** 6 hours.

**Acceptance Criteria:**

- Test validates correct webhook signature.
- Test rejects invalid webhook signature.
- Test confirms repeated `metaMessageId` does not duplicate messages.
- Test confirms a conversation is created or reused for the same contact.
- Test confirms tenant A cannot read tenant B data.
- Tests run with Vitest.

### 22. Final README

**Priority:** P0

**Objective:** Document how to run the project, how the architecture works, and which trade-offs were made.

**Justification:** The challenge explicitly asks for documentation of decisions, assumptions and future improvements.

**Dependencies:** Items 1 through 21.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- README explains project overview.
- README explains architecture summary.
- README explains how to run Docker infrastructure.
- README explains how to run the backend and worker.
- README explains how to simulate an inbound message.
- README explains how to run tests.
- README lists environment variables.
- README documents architectural decisions, assumptions, trade-offs and future improvements.

### 23. Manual End-to-End Validation

**Priority:** P0

**Objective:** Validate the full local challenge flow before delivery.

**Justification:** A technically strong implementation still needs to run cleanly for the reviewer.

**Dependencies:** Items 1 through 22.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- `docker compose up -d` works.
- Backend starts on port `8000`.
- Mock Meta health endpoint works.
- `GET /webhook` works.
- `POST /webhook` validates signatures.
- Mock inbound simulation works.
- Inbound message is saved.
- Job is enqueued.
- Inbound message moves from `received` to `queued`.
- Worker processes the job.
- Outbound message is sent to the mock.
- Worker retry does not duplicate outbound replies.
- `GET /conversations` works.
- `GET /conversations/:id/messages` works.
- Tests pass.
- README is clear.

### Suggested Commits

```txt
feat: add tenant-scoped conversations api
test: cover webhook signature validation
test: cover idempotency and tenant isolation
test: cover conversation message flow
docs: add final readme with architecture decisions
chore: validate local challenge flow
```

## Milestone 5 - Important Improvements If Time Allows

### 24. Real OpenAI Provider

**Priority:** P1

**Objective:** Implement the real OpenAI provider behind the `AIProvider` interface.

**Justification:** Real LLM integration counts positively, but only after the async, secure and idempotent baseline is stable.

**Dependencies:** Items 15 and 16.

**Estimate:** 4 hours.

**Acceptance Criteria:**

- `AI_PROVIDER=openai` uses the OpenAI SDK.
- The provider uses low temperature.
- The provider applies a timeout.
- Conversation history is limited.
- Token usage is logged when available.
- Missing knowledge-base information produces a safe fallback.

### 25. Additional Worker Tests

**Priority:** P1

**Objective:** Add tests for retry behavior and outbound idempotency.

**Justification:** The worker is the most failure-prone part of the system and is central to resilience.

**Dependencies:** Items 13, 14 and 17.

**Estimate:** 4 hours.

**Acceptance Criteria:**

- Retry does not create duplicate outbound messages.
- Meta send failure is retryable.
- Existing outbound reply is reused.
- Already sent replies are not sent again.

### 26. Recoverable Message Re-Enqueue Command

**Priority:** P1

**Objective:** Add a script or command to re-enqueue messages in `received` or `failed` status.

**Justification:** This closes the explicit recovery path for messages persisted when enqueue failed, without adding a full transactional outbox.

**Dependencies:** Item 12.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- The command lists eligible recoverable messages.
- The command re-enqueues messages safely.
- Re-enqueue respects idempotent job ids.
- The behavior is documented.

### 27. Multiple Messages in One Webhook Payload

**Priority:** P1

**Objective:** Process multiple text messages independently when they arrive in the same webhook payload.

**Justification:** This is closer to real Meta webhook behavior and avoids hidden limitations.

**Dependencies:** Item 10.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- A payload with multiple text messages creates multiple inbound messages.
- Each message gets its own job when eligible.
- A failure in one message does not prevent safe handling of the others.

### 28. Mock Meta Integration Test

**Priority:** P1

**Objective:** Add an integration validation that exercises the mock Meta inbound simulation and outbound send flow.

**Justification:** This gives strong confidence that the reviewer can reproduce the main behavior locally.

**Dependencies:** Item 23.

**Estimate:** 4 hours.

**Acceptance Criteria:**

- Simulated inbound message reaches the backend.
- Backend persists the inbound message.
- Worker sends outbound response to the mock.
- The test or validation script is documented.

### Suggested Commits

```txt
feat: add openai reply provider
test: cover worker retry idempotency
feat: add recoverable message enqueue command
feat: support multiple inbound webhook messages
test: add mock meta integration flow
```

## Milestone 6 - Differentiators

### 29. Function Calling Mock

**Priority:** P2

**Objective:** Add function calling for a real action, such as querying a mocked order status endpoint.

**Justification:** Function calling is explicitly mentioned as a differentiator in the challenge.

**Dependencies:** Item 24.

**Estimate:** 6 hours.

**Acceptance Criteria:**

- The model can call a defined function when appropriate.
- The function returns deterministic mock data.
- The final reply includes the function result.
- The system falls back safely when the function is not applicable.

### 30. Simple Tenant Rate Limiting

**Priority:** P2

**Objective:** Add basic rate limiting per tenant.

**Justification:** Rate limiting protects cost and availability, but is not necessary for the challenge baseline.

**Dependencies:** Item 18.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- Requests are limited per tenant.
- Limit behavior is documented.
- Errors are clear and do not leak other tenant data.

### 31. Failed Job Inspection

**Priority:** P2

**Objective:** Add minimal inspection for permanently failed jobs.

**Justification:** This improves operations, but a full dead-letter queue is beyond the core challenge.

**Dependencies:** Item 13.

**Estimate:** 4 hours.

**Acceptance Criteria:**

- Failed jobs can be inspected locally.
- Failed jobs include correlation information.
- The README explains how to inspect failures.

### 32. Basic Operational Metrics

**Priority:** P2

**Objective:** Expose simple counters for webhooks, jobs, AI failures and Meta send failures.

**Justification:** Metrics are a useful production signal, but structured logs are enough for the initial challenge.

**Dependencies:** Item 3.

**Estimate:** 3 hours.

**Acceptance Criteria:**

- Metrics do not include PII.
- Metrics include counts for webhook received, job processed, AI failure and Meta send failure.
- Metrics are documented.

### Suggested Commits

```txt
feat: add ai function calling for order status
feat: add tenant rate limiting
chore: add failed job inspection
chore: expose basic operational metrics
```

## Technical Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Signature validation uses parsed JSON instead of raw body | Real Meta webhook validation may fail, and security would be weaker | Capture raw body before JSON parsing and test HMAC behavior |
| Idempotency exists only in application code | Duplicate rows or duplicate jobs under concurrent webhook deliveries | Enforce unique constraints in PostgreSQL and handle conflict paths explicitly |
| Worker sends duplicate replies during retries | End users may receive duplicated WhatsApp responses | Use `replyToMessageId` as a unique key and check existing outbound messages before generation and send |
| Queue enqueue fails after message persistence | Message remains unprocessed | Keep status as `received`, log `job_enqueue_failed`, and optionally add a P1 recovery command |
| Tenant filtering is missed in a query | Cross-tenant data leak | Require tenant-aware repository methods and test negative access cases |
| OpenAI calls are slow, unstable or expensive | Worker latency, retries and cost increase | Use timeout, low temperature, limited history, stub mode and fallback behavior |
| Scope grows beyond the timebox | Mandatory baseline remains incomplete | Cut P2 and lower-value P1 items before touching P0 items |
| Meta payloads include unsupported event types | Parser errors or noisy failures | Make parser tolerant and explicitly ignore unsupported events with structured logs |
| Raw payload storage includes PII | Privacy and security risk | Keep `rawPayload` optional and document the risk |
| Local Docker dependencies fail for reviewer | Poor delivery experience | Keep setup simple, document commands, and validate the full flow before submission |

## Scope Cuts If Time Gets Tight

Cut in this order:

1. All P2 items:
   - function calling mock;
   - tenant rate limiting;
   - failed job inspection;
   - basic operational metrics.

2. P1 items in this order:
   - mock Meta integration test;
   - multiple messages in one webhook payload;
   - recoverable message re-enqueue command;
   - additional worker retry tests;
   - real OpenAI provider.

3. Keep the `AIProvider` interface and stub even if the real OpenAI integration is cut.

Do not cut:

- webhook signature validation;
- inbound persistence;
- inbound idempotency;
- queue and worker separation;
- outbound worker idempotency;
- Meta mock outbound send;
- tenant-scoped REST API;
- minimum required tests;
- final README with architecture decisions and trade-offs.

Security, idempotency and asynchronous processing are the highest-value parts of the challenge and should remain protected even under deadline pressure.
