import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHttpApp } from "../src/app.js";

describe("GET /webhook Meta handshake", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildHttpApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the challenge when verify_token is correct", async () => {
    const challenge = "challenge-123";
    const response = await app.inject({
      method: "GET",
      url: `/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=${challenge}`,
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
