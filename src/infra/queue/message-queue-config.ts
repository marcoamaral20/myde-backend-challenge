import type { BackoffOptions, JobsOptions } from "bullmq";

export const PROCESS_INBOUND_MESSAGE_ATTEMPTS = 3;
export const PROCESS_INBOUND_MESSAGE_BACKOFF: BackoffOptions = {
  type: "exponential",
  delay: 1_000,
};
// BullMQ v5 does not expose a native job timeout in JobsOptions here.
// The worker applies this as a processor timeout; abortable external calls
// such as MetaClient also keep their own request timeout.
export const PROCESS_INBOUND_MESSAGE_JOB_TIMEOUT_MS = 60_000;
export const PROCESS_INBOUND_MESSAGE_WORKER_CONCURRENCY = 2;

export const processInboundMessageJobOptions: JobsOptions = {
  attempts: PROCESS_INBOUND_MESSAGE_ATTEMPTS,
  backoff: PROCESS_INBOUND_MESSAGE_BACKOFF,
  removeOnComplete: true,
  removeOnFail: true,
};
