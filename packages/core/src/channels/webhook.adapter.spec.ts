import { describe, expect, it } from 'vitest';
import { buildSignature, verifySignature } from './webhook.adapter';

const SECRET = 'whsec_test_abc123';
const BODY = JSON.stringify({ id: 'msg_1', event: 'order.shipped' });

describe('webhook signing', () => {
  it('produces a t=…,v1=… header that verifies', () => {
    const now = 1_800_000_000;
    const header = buildSignature(SECRET, now, BODY);

    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature(SECRET, header, BODY, 300, now)).toBe(true);
  });

  it('rejects a body that was tampered with in transit', () => {
    const now = 1_800_000_000;
    const header = buildSignature(SECRET, now, BODY);
    expect(verifySignature(SECRET, header, `${BODY} tampered`, 300, now)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const now = 1_800_000_000;
    const header = buildSignature('whsec_other', now, BODY);
    expect(verifySignature(SECRET, header, BODY, 300, now)).toBe(false);
  });

  it('rejects a replayed signature once it falls outside the tolerance', () => {
    const signedAt = 1_800_000_000;
    const header = buildSignature(SECRET, signedAt, BODY);

    // Still inside the 5-minute window.
    expect(verifySignature(SECRET, header, BODY, 300, signedAt + 299)).toBe(true);
    // Past it — this is the replay protection the timestamp exists for.
    expect(verifySignature(SECRET, header, BODY, 300, signedAt + 301)).toBe(false);
  });

  it('rejects a signature timestamped too far in the future', () => {
    const signedAt = 1_800_000_000;
    const header = buildSignature(SECRET, signedAt, BODY);
    expect(verifySignature(SECRET, header, BODY, 300, signedAt - 600)).toBe(false);
  });

  it('rejects malformed headers instead of throwing', () => {
    for (const bad of ['', 'garbage', 't=abc,v1=def', 'v1=onlysig', 't=1800000000']) {
      expect(verifySignature(SECRET, bad, BODY, 300, 1_800_000_000)).toBe(false);
    }
  });
});
