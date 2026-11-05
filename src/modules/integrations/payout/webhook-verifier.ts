import { createHmac, timingSafeEqual } from 'node:crypto';

const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * @class WebhookVerifier
 * @description Checks a payout webhook's `x-signature`:
 * hex HMAC-SHA256 of the RAW body with the shared secret.
 * Over the raw bytes, because re-serialising parsed JSON changes them.
 * In constant time, so a forger learns nothing from how long a wrong guess took.
 */
export class WebhookVerifier {
  constructor(private readonly secret: string) {}

  /**
   * @param rawBody - the request body exactly as received
   * @param signature - the `x-signature` header
   * @returns true only for the exact signature of these bytes
   */
  verify(rawBody: Buffer, signature: string | undefined): boolean {
    if (signature === undefined || !HEX_SHA256.test(signature)) return false;
    const expected = createHmac('sha256', this.secret).update(rawBody).digest();
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  }
}
