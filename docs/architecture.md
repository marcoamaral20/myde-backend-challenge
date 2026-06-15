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

## Proposed Folder Structure

```txt
src/
  domain/
    entities/
    errors/
    value-objects/

  modules/
    webhook/
    conversations/
    messages/
    tenants/
    ai/
    jobs/

  infra/
    db/
    queue/
    openai/
    meta/
    knowledge-base/

  shared/
    env/
    logger/
    http/
    middlewares/
    errors/

  app.ts
  server.ts
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
4. persists the contact, conversation and inbound message;
5. guarantees idempotency using the Meta message id;
6. enqueues a background job;
7. returns `200` quickly.

The webhook handler must not call OpenAI directly.

---

### 3. Background Worker

The worker processes the queued job.

It:

1. loads the inbound message;
2. loads the conversation history;
3. loads the local knowledge base;
4. calls the AI provider;
5. saves the outbound message;
6. sends the reply to the Meta API mock.

Failures in OpenAI or Meta API sending should be retried by the queue.

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
direction
role
content
status
createdAt
updatedAt
```

---

## Idempotency

Meta may redeliver the same webhook more than once.

To avoid duplicate processing, the `messages` table must enforce:

```txt
unique(tenantId, metaMessageId)
```

If a message with the same `metaMessageId` already exists for the same tenant, the webhook returns `200` and does not enqueue a new job.

This makes idempotency reliable even if multiple backend instances receive the same webhook concurrently.

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
```

In production, SQS could be considered depending on the deployment environment.

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
jobId
correlationId
event
```

Important events:

```txt
webhook_received
signature_invalid
message_already_processed
message_persisted
job_enqueued
worker_started
ai_reply_generated
meta_reply_sent
worker_failed
```

---

## REST API

### GET /conversations

Lists conversations for the authenticated tenant.

### GET /conversations/:id/messages

Lists messages for a specific conversation, only if the conversation belongs to the tenant.

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
* end-to-end tests with the mock Meta server.
