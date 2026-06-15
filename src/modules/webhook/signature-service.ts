import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";

export class SignatureService {
  constructor(private readonly appSecret: string) {}

  isValidSignature(rawBody: Buffer, signatureHeader: string | undefined) {
    if (!signatureHeader?.startsWith(SIGNATURE_PREFIX)) {
      return false;
    }

    const receivedSignature = signatureHeader.slice(SIGNATURE_PREFIX.length);

    if (!/^[a-f0-9]+$/i.test(receivedSignature)) {
      return false;
    }

    const expectedSignature = createHmac("sha256", this.appSecret)
      .update(rawBody)
      .digest("hex");

    const received = Buffer.from(receivedSignature, "hex");
    const expected = Buffer.from(expectedSignature, "hex");

    if (received.length !== expected.length) {
      return false;
    }

    return timingSafeEqual(received, expected);
  }
}
