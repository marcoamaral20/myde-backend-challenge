import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHttpApp } from "../src/app.js";

vi.mock("../src/infra/queue/message-queue.js", () => ({
  BullMqMessageQueue: class {
    async close() {}
  },
}));

describe("GET /webhook Meta handshake", () => {
  let app: FastifyInstance;
  const verifyToken = process.env.META_VERIFY_TOKEN ?? "test-verify-token";

  beforeEach(async () => {
    app = await buildHttpApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the challenge when verify_token is correct", async () => {
    const challenge = "challenge-123";
    const query = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": verifyToken,
      "hub.challenge": challenge,
    });
    const response = await app.inject({
      method: "GET",
      url: `/webhook?${query.toString()}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(challenge);
  });

  it("returns 403 when verify_token is incorrect", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=challenge-123",
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns 403 when required query parameters are missing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/webhook",
    });

    expect(response.statusCode).toBe(403);
  });
});
