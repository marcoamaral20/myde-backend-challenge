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

Required variables:

```txt
PORT
DATABASE_URL
REDIS_URL
META_VERIFY_TOKEN
META_APP_SECRET
META_API_BASE_URL
OPENAI_API_KEY
AI_PROVIDER
```

Use Zod to validate environment variables at startup.

If required variables are missing, the app should fail fast.

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
* `messages` has `direction`;
* `messages` has `role`;
* `messages` has `status`;
* `messages` has `metaMessageId`;
* unique constraint on `(tenantId, metaMessageId)`.

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
4. save inbound message;
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
* do not enqueue another job;
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

Job payload:

```txt
tenantId
conversationId
messageId
```

Job options:

```txt
attempts: 3
backoff: exponential
```

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
3. load conversation context;
4. call AI service;
5. send reply to Meta mock;
6. save outbound message.

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
* filter every query by tenant;
* never expose data from another tenant.

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
message_persisted
message_already_processed
job_enqueued
worker_started
ai_reply_generated
meta_reply_sent
worker_failed
```

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
worker processes job
outbound message is sent to mock
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
4. queue and worker
5. outbound mock Meta sending
6. tenant-scoped REST API
7. tests
8. OpenAI real integration
9. function calling
```

Do not sacrifice security, idempotency or async processing to implement optional features.
