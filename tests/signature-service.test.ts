import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignatureService } from "../src/modules/webhook/signature-service.js";

const sign = (rawBody: Buffer, appSecret: string) =>
  `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;

describe("SignatureService", () => {
  it("accepts a valid webhook signature", () => {
    const appSecret = "test-app-secret";
    const rawBody = Buffer.from(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: "entry-1" }],
      }),
    );
    const signatureService = new SignatureService(appSecret);

    expect(signatureService.isValidSignature(rawBody, sign(rawBody, appSecret)))
      .toBe(true);
  });

  it("rejects an invalid webhook signature", () => {
    const appSecret = "test-app-secret";
    const wrongAppSecret = "wrong-app-secret";
    const rawBody = Buffer.from(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: "entry-1" }],
      }),
    );
    const signatureService = new SignatureService(appSecret);

    expect(
      signatureService.isValidSignature(rawBody, sign(rawBody, wrongAppSecret)),
    ).toBe(false);
  });
});
