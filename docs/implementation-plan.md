# Implementation Plan

## Goal

Build a production-minded backend for the Myde technical challenge.

The solution should be simple, reliable and easy to explain in a technical interview.

The priorities are:

1. secure webhook handling;
2. message persistence;
3. idempotency;
4. async processing;
5. tenant isolation;
6. AI response generation;
7. tests;
8. clear documentation.

---

## Step 1 — Project Setup

Create the initial project structure.

```txt
docs/
  challenge.md
  architecture.md
  implementation-plan.md

src/
  domain/
  modules/
  infra/
  shared/
```

Initial commits:

```txt
docs: add challenge requirements
docs: define architecture
docs: add implementation plan
chore: setup project structure
```

---

## Step 2 — Environment Configuration

Create environment validation.

Validated variables:

```txt
PORT
DATABASE_URL
REDIS_URL
META_VERIFY_TOKEN
META_APP_SECRET
META_API_BASE_URL
AI_PROVIDER
OPENAI_API_KEY
```

Use Zod to validate environment variables at startup.

If required variables are missing, the app should fail fast.

`OPENAI_API_KEY` is required only when `AI_PROVIDER=openai`.

When `AI_PROVIDER=stub`, the application must start without an OpenAI key.

---

## Step 3 — Database Schema

Implement Drizzle schema for:

```txt
tenants
contacts
conversations
messages
```

Important rules:

* every relevant table has `tenantId`;
* `tenants.phoneNumberId` is unique;
* `contacts` has a unique constraint on `(tenantId, waId)`;
* `messages` has `direction`;
* `messages` has `role`;
* `messages` has `processingStatus`;
* `messages` does not have a generic `status` field in the initial model;
* future Meta delivery/read webhooks should use a separate `deliveryStatus` field if needed;
* `messages` has `metaMessageId`, which is required for inbound messages and may be empty for outbound messages;
* `messages` has `replyToMessageId` to link outbound replies to inbound messages;
* `messages` has `failureReason`, `receivedAt`, `processedAt` and `sentAt`;
* `messages` may have optional `rawPayload` for debugging, with the PII risk documented;
* unique constraint on `(tenantId, metaMessageId)` when `metaMessageId` exists;
* unique constraint on `(tenantId, replyToMessageId)` when `replyToMessageId` exists.

Create seed data for a demo tenant.

Expected commit:

```txt
feat: add database schema and initial migrations
```

---

## Step 4 — Webhook GET

Implement:

```txt
GET /webhook
```

Behavior:

* read `hub.mode`;
* read `hub.verify_token`;
* read `hub.challenge`;
* compare token with `META_VERIFY_TOKEN`;
* return challenge if valid;
* return 403 if invalid.

Expected commit:

```txt
feat: implement webhook verification endpoint
```

---

## Step 5 — Webhook Signature Validation

Implement a dedicated service:

```txt
SignatureService
```

Responsibilities:

* receive raw body;
* receive `X-Hub-Signature-256`;
* compute HMAC-SHA256 with `META_APP_SECRET`;
* compare safely with `crypto.timingSafeEqual`.

Invalid signatures must return `401`.

Expected commit:

```txt
feat: validate meta webhook signatures
```

---

## Step 6 — Parse Meta Payload

Create a parser for the Meta webhook payload.

The parser should extract:

```txt
phoneNumberId
messageId
from
text
timestamp
```

Initial simplifications:

* process only text messages;
* ignore status events;
* ignore payloads without `messages`;
* process multiple messages one by one where practical, or document the limitation if only the first message is handled initially;
* return a safe response and log the event when `phoneNumberId` is unknown.

Keep the parser isolated from the HTTP controller.

Expected commit:

```txt
feat: parse inbound meta webhook payloads
```

---

## Step 7 — Persist Inbound Message

Implement use case:

```txt
ReceiveInboundMessageUseCase
```

Responsibilities:

1. resolve tenant by `phoneNumberId`;
2. create or find contact by WhatsApp id;
3. create or find active conversation;
4. save inbound message with `processingStatus = received`;
5. return whether the message is new or duplicated.

Expected commit:

```txt
feat: persist inbound whatsapp messages
```

---

## Step 8 — Idempotency

Guarantee duplicate webhooks are not processed twice.

Rules:

* if `metaMessageId` already exists for the tenant, return success;
* do not create another message;
* if the existing message is `queued`, `processing`, `reply_generated` or `sent`, do not enqueue another job;
* if the existing message is still `received` or `failed`, the system may try to enqueue it again;
* log `message_already_processed`.

Expected commit:

```txt
feat: add idempotent inbound message handling
```

---

## Step 9 — Queue Setup

Configure BullMQ.

Create:

```txt
MessageQueue
ProcessInboundMessageJob
```

The webhook should enqueue a job only after a new inbound message is persisted.

The inbound message is first persisted with:

```txt
processingStatus = received
```

After enqueue succeeds, update it to:

```txt
processingStatus = queued
```

If enqueue fails, keep the message as `received`, log `job_enqueue_failed` and still return `200` from the webhook.
This avoids unnecessary Meta redeliveries and makes the failure recoverable by a manual retry or a future recovery job that scans `received` messages.

Job payload:

```txt
tenantId
conversationId
messageId
correlationId
```

Job options:

```txt
attempts: 3
backoff: exponential
jobId: tenantId-messageId
timeout: fixed timeout per job
concurrency: low initial value
```

The worker process should support graceful shutdown.

A dead-letter queue is not required for the challenge and remains a future improvement.

Expected commit:

```txt
feat: add async message processing queue
```

---

## Step 10 — Worker Setup

Create the worker process.

The worker should:

1. receive job;
2. load message;
3. verify that the message can still be processed;
4. mark the inbound message as `processing`;
5. check whether an outbound message already exists with `replyToMessageId = inboundMessage.id`;
6. load conversation context;
7. call AI service;
8. save outbound message linked with `replyToMessageId`;
9. mark the inbound message as `reply_generated`;
10. send reply to Meta mock;
11. mark the inbound message as `sent`.

Worker idempotency rules:

* do not generate a second outbound reply if one already exists for the inbound message;
* if an outbound reply exists but has not been sent, reuse it for the Meta send;
* if an outbound reply was already sent, finish without sending again;
* use `replyToMessageId` as the logical idempotency key for replies;
* set `processingStatus = failed` and save `failureReason` when processing fails after retries or due to a non-retryable error;
* retries must not produce duplicate Meta sends.

Expected commit:

```txt
feat: process inbound messages with worker
```

---

## Step 11 — AI Provider

Create an AI abstraction.

```txt
AIProvider
  generateReply(input): Promise<string>
```

Implement:

```txt
StubAIProvider
OpenAIProvider
```

Rules:

* use stub when `AI_PROVIDER=stub`;
* use OpenAI when `AI_PROVIDER=openai`;
* require `OPENAI_API_KEY` only when using OpenAI;
* do not couple business logic directly to the OpenAI SDK.

Expected commit:

```txt
feat: add ai provider abstraction
```

---

## Step 12 — Knowledge Base Service

Create:

```txt
KnowledgeBaseService
```

Responsibilities:

* load files from `knowledge-base/`;
* expose content to the AI service;
* keep implementation simple.

Expected commit:

```txt
feat: load knowledge base for ai context
```

---

## Step 13 — Prompt Strategy

Implement prompt rules:

```txt
- answer only using the knowledge base;
- if information is missing, say you do not know;
- keep the answer short and suitable for WhatsApp;
- do not invent prices, deadlines or policies.
```

Operational rules:

* limit the conversation history sent to the model;
* use low temperature;
* apply a timeout to the OpenAI call;
* log token usage when available;
* use an explicit fallback when the knowledge base does not contain the answer.

Expected commit:

```txt
feat: generate grounded ai replies
```

---

## Step 14 — Meta Client

Create:

```txt
MetaClient
```

Responsibilities:

* send outbound messages to the mock Meta endpoint;
* isolate HTTP details from the worker;
* log request failures.

Endpoint:

```txt
POST /{phoneNumberId}/messages
```

Expected commit:

```txt
feat: send outbound replies to meta mock
```

---

## Step 15 — REST API

Implement:

```txt
GET /conversations
GET /conversations/:id/messages
```

Rules:

* require `x-tenant-id`;
* return an error when `x-tenant-id` is missing or invalid;
* filter every query by tenant;
* never expose data from another tenant;
* do not reveal whether a conversation exists under another tenant;
* order conversation messages deterministically by `receivedAt` or `createdAt`.

Expected commit:

```txt
feat: add tenant-scoped conversations api
```

---

## Step 16 — Logging

Add structured logs to important operations.

Events:

```txt
webhook_received
signature_invalid
tenant_resolved
message_persisted
message_already_processed
job_enqueued
job_enqueue_failed
worker_started
worker_retrying
ai_reply_generated
ai_call_failed
meta_reply_sent
meta_send_failed
message_processing_completed
worker_failed
```

Correlation rules:

* generate `correlationId` when the webhook is received;
* include `correlationId` in the job payload;
* log the same `correlationId` from the webhook and worker paths.

Expected commit:

```txt
chore: add structured application logs
```

---

## Step 17 — Tests

Implement at least 5 tests.

Required tests:

```txt
1. validates correct webhook signature
2. rejects invalid webhook signature
3. does not duplicate message on repeated metaMessageId
4. creates or reuses conversation for same contact
5. prevents tenant A from reading tenant B data
```

Optional tests:

```txt
6. worker saves outbound message
7. AI fallback says it does not know
8. failed Meta API call is retried
9. persisted message remains recoverable when enqueue fails
10. worker retry does not duplicate outbound message
11. unknown tenant in webhook is handled safely
12. missing or invalid x-tenant-id is rejected
13. parser ignores payload without text
```

Expected commits:

```txt
test: cover webhook signature validation
test: cover idempotency and tenant isolation
test: cover conversation message flow
```

---

## Step 18 — README

Write the final README.

It must include:

```txt
- project overview
- architecture summary
- how to run
- how to simulate an inbound message
- how to run tests
- environment variables
- architectural decisions
- assumptions
- trade-offs
- future improvements
```

Expected commit:

```txt
docs: add final readme with architecture decisions
```

---

## Step 19 — Manual Validation Checklist

Before submitting, validate:

```txt
docker compose up -d works
backend starts on port 8000
mock Meta health endpoint works
GET /webhook works
POST /webhook validates signature
mock inbound simulation works
inbound message is saved
job is enqueued
inbound message moves from received to queued
worker processes job
outbound message is sent to mock
worker retry does not duplicate outbound reply
GET /conversations works
GET /conversations/:id/messages works
tests pass
README is clear
```

---

## Step 20 — Delivery

Final email subject:

```txt
Avaliação técnica – Desenvolvedor backend – Marco Amaral
```

Email body:

```txt
Olá, tudo bem?

Segue minha entrega para a avaliação técnica de Desenvolvedor Backend.

Repositório:
{repository_url}

No README deixei as instruções para execução local, decisões de arquitetura, premissas consideradas e pontos que eu evoluiria em um cenário de produção.

Fico à disposição.

Obrigado!
Marco Amaral
```

---

## Priority If Time Gets Short

If time becomes limited, prioritize:

```txt
1. webhook signature validation
2. inbound persistence
3. idempotency
4. queue and idempotent worker
5. outbound mock Meta sending
6. tenant-scoped REST API
7. tests
8. OpenAI real integration
9. function calling
```

Do not sacrifice security, idempotency or async processing to implement optional features.
