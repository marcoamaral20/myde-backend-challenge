import { Queue } from "bullmq";
import { env } from "../../shared/env/index.js";
import { processInboundMessageJobOptions } from "./message-queue-config.js";

export const PROCESS_INBOUND_MESSAGE_QUEUE = "process-inbound-message";

export type ProcessInboundMessageJob = {
  tenantId: string;
  conversationId: string;
  messageId: string;
  correlationId: string;
};

export interface MessageQueue {
  enqueueProcessInboundMessage(
    job: ProcessInboundMessageJob,
  ): Promise<{ jobId: string }>;
  close(): Promise<void>;
}

export class BullMqMessageQueue implements MessageQueue {
  private readonly queue: Queue<ProcessInboundMessageJob>;

  constructor(redisUrl = env.REDIS_URL) {
    this.queue = new Queue<ProcessInboundMessageJob>(
      PROCESS_INBOUND_MESSAGE_QUEUE,
      {
        connection: parseRedisConnection(redisUrl),
        defaultJobOptions: processInboundMessageJobOptions,
      },
    );
  }

  async enqueueProcessInboundMessage(job: ProcessInboundMessageJob) {
    const jobId = `${job.tenantId}:${job.messageId}`;
    const createdJob = await this.queue.add("process-inbound-message", job, {
      jobId,
    });

    return { jobId: createdJob.id ?? jobId };
  }

  async close() {
    await this.queue.close();
  }
}

export const parseRedisConnection = (redisUrl: string) => {
  const parsedUrl = new URL(redisUrl);

  return {
    host: parsedUrl.hostname,
    port: parsedUrl.port ? Number(parsedUrl.port) : 6379,
    username: parsedUrl.username || undefined,
    password: parsedUrl.password || undefined,
    db: parsedUrl.pathname ? Number(parsedUrl.pathname.slice(1) || 0) : 0,
    maxRetriesPerRequest: null,
    tls: parsedUrl.protocol === "rediss:" ? {} : undefined,
  };
};
