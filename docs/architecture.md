# Architecture

## Overview

This project implements a backend for a WhatsApp-based AI support assistant.

The system receives signed webhooks from the Meta WhatsApp Cloud API, persists inbound messages, enqueues asynchronous processing jobs, generates AI-based replies using a knowledge base, and sends outbound messages back through the Meta API mock.

The main goals are:

* respond quickly to webhook requests;
* validate webhook authenticity;
* persist contacts, conversations and messages;
* process AI replies asynchronously;
* avoid duplicate processing through idempotency;
* isolate data by tenant;
* provide minimal REST APIs for conversations and messages;
* keep the codebase modular, testable and easy to reason about.

---

## Architectural Style

The project follows a modular architecture inspired by Clean Architecture / Hexagonal Architecture.

The main idea is to separate:

* business rules;
* application use cases;
* infrastructure adapters;
* HTTP routes;
* external integrations.

This avoids coupling the core logic directly to Fastify, BullMQ, OpenAI, PostgreSQL or the Meta API.

---

## Current Folder Structure

```txt
.
  docker-compose.yml
  knowledge-base/                 Official Markdown knowledge-base assets
  mock-meta-server/               Official Meta API mock
  scripts/                        Local setup and validation helpers
  .github/workflows/              CI workflow

src/
  app.ts                          Fastify app composition
  server.ts                       HTTP process entrypoint
  worker.ts                       BullMQ worker entrypoint

  infra/
    db/                           Drizzle schema, database connection and seed
    knowledge-base/               Local knowledge-base loader
    meta/                         Meta outbound HTTP client
    queue/                        BullMQ queue adapter and job configuration

  modules/
    ai/                           AIProvider interface, OpenAI and stub providers
    conversations/                Conversation REST routes and query services
    messages/                     Inbound receive, processing and recovery use cases
    tenants/                      REST tenant header middleware
    webhook/                      Meta signature validation, parsing and routes

  shared/
    env/                          Environment validation
    logger/                       Structured logger setup
    tracing/                      Correlation id helper

tests/                            Vitest business and integration tests
docs/                             Challenge, architecture, plan, backlog and validation docs
```

---

## Main Flow

### 1. Webhook Verification

Meta calls:

```txt
GET /webhook
```

The backend validates `hub.verify_token` against `META_VERIFY_TOKEN`.

If valid, it returns `hub.challenge`.

---

### 2. Inbound Message Webhook

Meta sends:

```txt
POST /webhook
```

The backend:

1. reads the raw request body;
2. validates `X-Hub-Signature-256` using `META_APP_SECRET`;
3. extracts the tenant from `phoneNumberId`;
4. generates a `correlationId` for the request;
5. persists the contact, conversation and inbound message with `processingStatus = received`;
6. guarantees idempotency using the Meta message id;
7. enqueues a background job;
8. updates the inbound message to `processingStatus = queued` only after enqueue succeeds;
9. returns `200` quickly.

If enqueue fails after the message is persisted, the webhook still returns `200`.
The message remains with `processingStatus = received`, and the error is logged as `job_enqueue_failed`.
This avoids unnecessary Meta redeliveries while keeping recovery explicit through the database.
A future recovery process or manual retry can enqueue `received` messages again.

If Meta redelivers a webhook for a message that already exists with `processingStatus = received` or `failed`, the system may try to enqueue it again instead of treating it as fully processed.

The webhook handler must not call OpenAI directly.

---

### Supported Meta Payloads

The first version intentionally handles a small subset of the Meta webhook payload:

* only text messages are processed;
* status events are ignored;
* payloads without `messages` are ignored and acknowledged safely;
* if a webhook contains multiple messages, each message should be processed independently where practical;
* if `phoneNumberId` does not match a known tenant, the system logs the event and returns a safe response without processing the message.

These constraints keep the challenge implementation focused while making the simplifications explicit.

---

### 3. Background Worker

The worker processes the queued job.

It:

1. loads the inbound message;
2. verifies that the message can still be processed;
3. marks the inbound message as `processing`;
4. checks whether an outbound reply already exists for `replyToMessageId = inboundMessage.id`;
5. loads the conversation history;
6. loads the local knowledge base;
7. calls the AI provider;
8. saves the outbound message linked to the inbound message;
9. sends the reply to the Meta API mock;
10. marks the inbound message as `sent`.

Failures in OpenAI or Meta API sending should be retried by the queue.

The worker must be idempotent. If a retry happens after a partial failure, it must not send duplicate replies to Meta.

The logical idempotency key for replies is:

```txt
replyToMessageId
```

Before generating or sending a response, the worker checks whether an outbound message already exists for the inbound message.
If a reply exists but has not been sent, the worker reuses that reply instead of generating another one.
If a reply has already been sent, the worker finishes without sending again.

---

## Processing Status

Inbound messages use the following lifecycle:

```txt
received
queued
processing
reply_generated
sent
failed
```

Status meaning:

* `received`: persisted but not yet successfully enqueued;
* `queued`: background job was created;
* `processing`: worker started processing;
* `reply_generated`: AI response was generated and persisted;
* `sent`: response was sent to Meta;
* `failed`: processing failed after retries or due to a non-retryable error.

Outbound replies use the same `processingStatus` enum and additionally move
through `sending` while the worker is calling Meta. Ambiguous outbound
`sending` or `failed` states are not automatically resent because the previous
Meta request may already have been accepted.

This is intentionally simpler than a full transactional outbox, but it avoids silently losing persisted messages when queue enqueue fails.

---

## Database Model

### tenants

Represents a customer/company using the platform.

```txt
id
name
phoneNumberId
createdAt
updatedAt
```

Constraints:

```txt
unique(phoneNumberId)
```

---

### contacts

Represents WhatsApp users.

```txt
id
tenantId
waId
name
createdAt
updatedAt
```

Constraints:

```txt
unique(tenantId, waId)
```

---

### conversations

Represents a conversation between a tenant and a contact.

```txt
id
tenantId
contactId
status
createdAt
updatedAt
```

---

### messages

Represents inbound and outbound messages.

```txt
id
tenantId
conversationId
contactId
metaMessageId
replyToMessageId
direction
role
content
processingStatus
failureReason
rawPayload
receivedAt
processedAt
sentAt
createdAt
updatedAt
```

Notes:

* `metaMessageId` is required for inbound messages and may be empty for outbound messages;
* `replyToMessageId` links an outbound message to the inbound message it answers;
* `processingStatus` is the only message status in the initial model;
* `rawPayload` is optional and useful for debugging, but it may contain PII and should be handled carefully.

The initial model does not include a generic `status` column in `messages`.
If future Meta delivery/read webhooks are supported, they should use a separate `deliveryStatus` field instead of overloading `processingStatus`.

Constraints:

```txt
unique(tenantId, metaMessageId) where metaMessageId is not null
unique(tenantId, replyToMessageId) where replyToMessageId is not null
```

---

## Idempotency

Meta may redeliver the same webhook more than once.

To avoid duplicate processing, the `messages` table must enforce:

```txt
unique(tenantId, metaMessageId) where metaMessageId is not null
```

If a message with the same `metaMessageId` already exists for the same tenant:

* if it is already `queued`, `processing`, `reply_generated` or `sent`, the webhook returns `200` and does not enqueue another job;
* if it is still `received` or `failed`, the system may attempt to enqueue it again;
* no duplicate inbound message is created.

This makes idempotency reliable even if multiple backend instances receive the same webhook concurrently.

Outbound idempotency is handled with `replyToMessageId`.
Only one outbound reply should exist for a given inbound message.

---

## Multi-Tenant Isolation

Every relevant record contains `tenantId`.

All queries must filter by `tenantId`.

For the REST API, the tenant is resolved from the request header:

```txt
x-tenant-id
```

This is a simplified approach for the challenge.

In production, this would be replaced by JWT, API keys, OAuth or another tenant-aware authentication strategy.

If `x-tenant-id` is missing or invalid, REST endpoints return an error.
When a conversation belongs to another tenant, the API must not reveal that the conversation exists.

---

## Queue Strategy

The project uses BullMQ with Redis.

Reasoning:

* Redis is already provided in the challenge infrastructure;
* BullMQ is simple to run locally;
* retries and backoff are built in;
* it keeps the webhook fast and resilient.

Example job behavior:

```txt
attempts: 3
backoff: exponential
jobId: tenantId-messageId
concurrency: low initial value
timeout: fixed timeout per job
```

Workers should support graceful shutdown so an in-flight job is either completed or retried by BullMQ.

In production, SQS could be considered depending on the deployment environment.
A dead-letter queue is a future improvement for permanently failed jobs.

---

## Environment Configuration

Environment variables are validated at startup.

`OPENAI_API_KEY` is required only when:

```txt
AI_PROVIDER=openai
```

When:

```txt
AI_PROVIDER=stub
```

the application can start without an OpenAI key.

---

## AI Strategy

The AI integration is abstracted behind an interface.

```txt
AIProvider
  generateReply(input): Promise<string>
```

There can be two implementations:

```txt
OpenAIProvider
StubAIProvider
```

The stub allows the project to run without an OpenAI API key and makes tests easier.

The AI response must be based only on the local knowledge base.

If the answer is not available in the knowledge base, the assistant should clearly say it does not know instead of inventing information.

The initial OpenAI strategy should:

* limit the conversation history sent to the model;
* use low temperature for more deterministic answers;
* apply a timeout to the AI call;
* log token usage when the provider returns it;
* use an explicit fallback when the knowledge base does not contain enough information.

---

## Knowledge Base Strategy

For this challenge, the knowledge base is loaded from local files.

This is enough for a small dataset.

In production, this could evolve to:

* embeddings;
* vector database;
* semantic search;
* document chunking;
* retrieval with similarity threshold.

---

## Observability

The application should use structured logs.

Important log fields:

```txt
tenantId
conversationId
messageId
metaMessageId
replyToMessageId
jobId
correlationId
event
```

The `correlationId` is generated when the webhook is received and propagated to the queued job.
It should appear in logs from both the HTTP request and the worker execution.

Important events include:

```txt
webhook_received
signature_invalid
webhook_payload_invalid_json
webhook_payload_ignored
tenant_unknown
message_already_processed
message_persisted
job_enqueued
job_enqueue_failed
message_mark_queued_failed
webhook_message_processing_failed
worker_started
worker_retrying
outbound_send_state_ambiguous
ai_reply_generated
ai_call_failed
meta_send_failed
message_processing_completed
worker_failed
worker_failed_status_update_failed
rest_tenant_resolved
rest_conversations_listed
rest_conversation_messages_listed
```

---

## REST API

### GET /conversations

Lists conversations for the authenticated tenant.

### GET /conversations/:id/messages

Lists messages for a specific conversation, only if the conversation belongs to the tenant.

Messages should be ordered deterministically, preferably by `receivedAt` and then `createdAt`.

No endpoint should return data from another tenant.

---

## Main Trade-Offs

### Simplified authentication

The project uses `x-tenant-id` for tenant resolution in REST APIs.

This is acceptable for the challenge, but not enough for production.

---

### Simple knowledge-base loading

The project loads the full knowledge base locally.

This is enough for the challenge, but a larger production system would need retrieval and vector search.

---

### BullMQ instead of SQS

BullMQ was chosen because Redis is already available locally.

In production, SQS could be a better fit for AWS-native infrastructure.

---

### Minimal REST API

The challenge only requires conversation listing and message listing.

No unnecessary CRUD endpoints were added.

---

## Future Improvements

* JWT/API key authentication per tenant;
* dead-letter queue for permanently failed jobs;
* rate limiting per tenant;
* vector search for the knowledge base;
* function calling for order status or other real actions;
* OpenTelemetry tracing;
* metrics with Prometheus/Grafana;
* admin panel for tenant management;
* automated end-to-end tests with the mock Meta server.
