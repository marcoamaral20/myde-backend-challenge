# Myde Backend Challenge

Backend implementation for a WhatsApp-based AI support assistant.

The service receives signed Meta WhatsApp webhooks, persists inbound messages,
queues asynchronous processing jobs, generates replies through an `AIProvider`,
and sends outbound messages back through the Meta API mock.

The implementation focuses on the parts that matter most for the challenge:
secure webhook handling, persistence, idempotency, asynchronous processing,
tenant isolation, testable boundaries and clear operational logs.

## Project Overview

The goal is to model a production-minded support flow without adding unnecessary
platform complexity.

At a high level:

1. A customer sends a WhatsApp message.
2. Meta calls `POST /webhook` with a signed payload.
3. The backend validates the raw-body HMAC signature.
4. The inbound message is persisted with tenant, contact and conversation data.
5. A BullMQ job is enqueued and the webhook returns quickly.
6. A worker loads the message, builds conversation context, calls the configured
   AI provider and persists an outbound reply.
7. The outbound reply is sent to the Meta API mock.

The webhook path never calls OpenAI directly. AI work runs in the worker process.

## Architecture

The project uses a modular architecture inspired by Clean Architecture /
Hexagonal Architecture. Business rules are kept behind use cases and services,
while framework and infrastructure details stay in adapters.

Main folders:

```txt
src/
  app.ts                         Fastify app composition
  server.ts                      HTTP process entrypoint
  worker.ts                      BullMQ worker entrypoint
  infra/
    db/                          Drizzle schema, database connection and seed
    queue/                       BullMQ queue adapter and job configuration
    meta/                        Meta outbound HTTP client
    knowledge-base/              Local knowledge-base loader
  modules/
    webhook/                     Signature validation, payload parsing, routes
    messages/                    Inbound receive and worker processing use cases
    conversations/               Tenant-scoped REST API and repository
    tenants/                     REST tenant header middleware
    ai/                          AIProvider interface, stub and OpenAI providers
  shared/
    env/                         Zod environment validation
    logger/                      Pino logger setup
    tracing/                     Correlation id helper
```

Key responsibilities:

- `SignatureService`: validates `X-Hub-Signature-256` with HMAC-SHA256 over the
  raw request body.
- `parseMetaWebhookPayload`: extracts supported text messages and ignores
  unsupported payloads safely.
- `ReceiveInboundMessageUseCase`: resolves tenant, creates or reuses contact and
  conversation, and persists inbound messages idempotently.
- `BullMqMessageQueue`: enqueues deterministic jobs using `tenantId:messageId`.
- `ProcessInboundMessageUseCase`: processes inbound jobs, handles outbound
  idempotency, calls AI and sends replies to Meta.
- `ConversationService`: exposes tenant-scoped conversation and message reads.

## Main Flow

### Webhook

`GET /webhook` implements the Meta verification handshake. It validates
`hub.verify_token` against `META_VERIFY_TOKEN` and returns `hub.challenge` when
valid.

`POST /webhook` reads the raw JSON body as a buffer, validates the Meta
signature, parses supported text messages, persists each inbound message and
enqueues background work. Invalid signatures are rejected with `401`.

Unsupported payloads, invalid JSON and unknown tenants are acknowledged safely
without crashing the handler.

### Persistence

PostgreSQL stores:

- `tenants`
- `contacts`
- `conversations`
- `messages`

Every relevant table includes `tenantId`. Inbound idempotency is enforced with a
unique index on `(tenantId, metaMessageId)` when `metaMessageId` is present.
Outbound reply idempotency is enforced with a unique index on
`(tenantId, replyToMessageId)` when `replyToMessageId` is present.

### Queue

BullMQ is backed by Redis. The webhook persists a message first, then enqueues a
job. After enqueue succeeds, the inbound message moves from `received` to
`queued`.

If enqueue fails after persistence, the webhook still returns `200`. The message
stays as `received`, and the failure is logged. This avoids unnecessary Meta
redeliveries while keeping the recovery path explicit in the database.

### Worker

The worker consumes `process-inbound-message` jobs. It loads the inbound message,
marks it as `processing`, builds recent conversation history, loads the local
knowledge base and calls the configured AI provider.

The worker persists the outbound reply before sending it to Meta. If a retry
finds an existing outbound reply, it reuses that row instead of generating a
second answer.

### AI Provider

AI integration is behind an `AIProvider` interface.

Supported providers:

- `AI_PROVIDER=stub`: deterministic local provider for development and tests.
- `AI_PROVIDER=openai`: OpenAI SDK provider with timeout, low temperature and
  prompt rules that keep answers grounded in the knowledge base.

When `AI_PROVIDER=stub`, `OPENAI_API_KEY` is not required.

### Meta Outbound

Outbound replies are sent through:

```txt
POST {META_API_BASE_URL}/{phoneNumberId}/messages
```

The `MetaClient` isolates the HTTP request format and logs send failures so
BullMQ can retry the worker job when appropriate.

## Technology Stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js |
| Language | TypeScript |
| HTTP | Fastify |
| Database | PostgreSQL |
| ORM | Drizzle ORM |
| Queue backend | Redis |
| Queue | BullMQ |
| AI | OpenAI SDK behind `AIProvider` |
| Tests | Vitest |
| Logger | Pino |
| Validation | Zod |
| Package manager | npm |

## Running Locally

Install dependencies:

```bash
npm install
```

Start the challenge infrastructure:

```bash
docker compose up -d
```

The expected local infrastructure is:

- PostgreSQL on `localhost:5432`
- Redis on `localhost:6379`
- Meta API mock on `localhost:8001`

Create the environment file:

```bash
cp .env.example .env
```

Default local values:

```txt
PORT=8000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/myde
REDIS_URL=redis://localhost:6379
META_VERIFY_TOKEN=local-verify-token
META_APP_SECRET=local-app-secret
META_API_BASE_URL=http://localhost:8001
AI_PROVIDER=stub
OPENAI_MODEL=gpt-4.1-mini
OPENAI_TIMEOUT_MS=15000
LOG_LEVEL=info
```

These values intentionally mirror `.env.example`. The Meta mock must sign
webhooks with the same `META_APP_SECRET`, and any webhook verification request
must use the same `META_VERIFY_TOKEN`. If your local mock is configured with
different values, update `.env` or the mock configuration so both sides match.

Use `AI_PROVIDER=stub` for local validation without an OpenAI key. If using
`AI_PROVIDER=openai`, set `OPENAI_API_KEY`.

Run migrations and seed:

```bash
npm run db:migrate
npm run db:seed
```

Start the HTTP server:

```bash
npm run dev:http
```

Start the worker in another terminal:

```bash
npm run dev:worker
```

Recover messages that were persisted but not successfully processed:

```bash
npm run messages:reenqueue
```

This command scans inbound messages in `received` or `failed`, enqueues them
with the same deterministic `tenantId:messageId` job id used by the webhook
flow, and marks successfully enqueued messages as `queued`. It intentionally
does not re-enqueue `queued`, `processing`, `reply_generated`, `sending` or
`sent` messages.

Optionally limit each run:

```bash
REENQUEUE_LIMIT=50 npm run messages:reenqueue
```

For production-style local execution:

```bash
npm run build
npm run start:http
npm run start:worker
```

Note: the challenge statement provides Docker infrastructure and a Meta mock. If
your checkout does not include those files, use the equivalent local PostgreSQL,
Redis and mock Meta services with the same environment variables.

## Simulating an Inbound Message

With the HTTP server running on port `8000` and the mock Meta server running on
port `8001`, simulate an inbound WhatsApp message:

```bash
curl -X POST http://localhost:8001/simulate/inbound \
  -H "Content-Type: application/json" \
  -d '{
    "from": "5511999990000",
    "text": "Quais são os planos de vocês?"
  }'
```

The mock signs the webhook payload and calls the backend at
`POST http://host.docker.internal:8000/webhook`. The backend persists the inbound
message, queues processing, and the worker sends the generated response back to
the mock Meta API.

The seeded tenant uses:

```txt
phoneNumberId=demo-phone-number-id
```

The inbound webhook is resolved by `metadata.phone_number_id` from the Meta
payload. Make sure the mock sends `demo-phone-number-id`, or seed/update a
tenant with the phone number id emitted by your mock. If the values do not
match, the webhook will acknowledge the request but log the message as an
unknown tenant and skip processing.

## REST API

The REST API uses a simplified tenant header for the challenge:

```txt
x-tenant-id: <tenant uuid>
```

In production, this should be replaced by tenant-aware authentication such as
JWT, API keys or OAuth.

### GET /conversations

Lists conversations for the current tenant.

Example:

```bash
curl http://localhost:8000/conversations \
  -H "x-tenant-id: <tenant-id>"
```

Optional query parameters:

```txt
limit  default 50, max 100
offset default 0
```

### GET /conversations/:id/messages

Lists messages for a conversation owned by the current tenant.

Example:

```bash
curl http://localhost:8000/conversations/<conversation-id>/messages \
  -H "x-tenant-id: <tenant-id>"
```

If the conversation belongs to another tenant, the API returns `404` and does
not reveal cross-tenant data.

## Tests

Run type checks:

```bash
npm run check
```

Run the build:

```bash
npm run build
```

Run tests:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/myde_test npm test
```

`TEST_DATABASE_URL` is required for database tests. The test helper runs Drizzle
migrations before the suite and creates tenant data with a unique run id so the
tests do not depend on production or shared seed data.

Covered scenarios:

- valid webhook signature is accepted;
- invalid webhook signature is rejected;
- repeated `metaMessageId` does not create duplicate inbound messages;
- an active conversation is created or reused for the same contact;
- tenant A cannot read tenant B conversation messages.
- worker retry does not create duplicate outbound replies;
- existing pending outbound replies are reused;
- already sent outbound replies are not sent again;
- Meta send failures propagate so BullMQ can retry;
- ambiguous `sending` states are not resent automatically;
- recoverable inbound messages in `received` or `failed` can be re-enqueued.

The tests use `AI_PROVIDER=stub` behavior and do not depend on real OpenAI
calls.

## Architectural Decisions

### Asynchronous webhook

The webhook validates, persists and enqueues work, then returns quickly. This
keeps Meta delivery latency low and prevents AI or outbound API latency from
blocking the webhook request.

### BullMQ

BullMQ was chosen because Redis is already part of the local challenge
infrastructure, and BullMQ provides retries, backoff and deterministic job ids
with low operational overhead for this scope.

### Inbound idempotency

Meta can redeliver the same message. The system treats `metaMessageId` as the
inbound idempotency key per tenant and also enforces it at the database level.
That matters because application-level checks alone are not enough under
concurrent deliveries.

### Outbound idempotency

Outbound replies use `replyToMessageId` as the logical idempotency key. The
worker checks for an existing outbound reply before generating a new one, and
the database enforces one reply per inbound message per tenant.

The implementation is intentionally conservative around ambiguous send states.
Without a Meta-provided idempotency key or a transactional outbox, retrying after
an uncertain send can duplicate a WhatsApp message. In that case, the code
prefers surfacing the ambiguity for inspection.

### Multi-tenancy

Tenant isolation is enforced by storing `tenantId` on relevant records and by
requiring tenant-aware queries. REST endpoints resolve the tenant from
`x-tenant-id` and never return conversations or messages outside that tenant.

### AIProvider abstraction

The worker depends on `AIProvider`, not directly on OpenAI. This keeps the
business flow testable, allows local execution with `AI_PROVIDER=stub`, and
makes provider changes less invasive.

## Trade-offs

### No transactional outbox

The project does not implement a full transactional outbox. Instead, inbound
messages are persisted before enqueue, and enqueue failure leaves the message in
`received` for explicit recovery. This is simpler and sufficient for the
challenge, but a production system should add an outbox or scheduled recovery
workflow for stronger delivery guarantees.

### No vector database

The knowledge base is loaded from local files. For the challenge dataset this is
enough and keeps the system easy to run. For larger or frequently changing
content, embeddings and vector search would be a better retrieval strategy.

### No real authentication

REST tenant resolution uses `x-tenant-id`. This proves tenant-scoped data access
without introducing an auth provider. It is not production authentication.

### Local knowledge base

The local knowledge base keeps the AI path deterministic and inexpensive for
review. The trade-off is that it lacks document versioning, semantic retrieval,
access control and operational tooling that a production knowledge system would
need.

## Future Improvements

- Function calling for real actions, such as order status lookup.
- Dead-letter queue or failed-job inspection for permanently failed jobs.
- Stronger observability with metrics, tracing and dashboards.
- Provider failover between AI providers or models.
- Embeddings and vector search for larger knowledge bases.
- Production tenant authentication with JWT, API keys or OAuth.
- Scheduled recovery workflow for messages left in `received` after enqueue failure.
- End-to-end tests against the mock Meta server.

## Assumptions

- Only text inbound messages are processed.
- Status events and unsupported payload shapes are acknowledged and ignored.
- Unknown `phoneNumberId` values are logged and acknowledged safely.
- The local Meta mock is trusted to simulate signed inbound webhooks.
- The initial REST authentication model is intentionally simplified.
- The local knowledge base may be absent; in that case the AI provider falls
  back instead of inventing information.
- `AI_PROVIDER=stub` is the recommended default for local review without an
  OpenAI key.
- Queue retries are handled by BullMQ; full DLQ operations are a future
  improvement.
