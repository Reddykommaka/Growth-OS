/**
 * Upload policy and storage keys.
 *
 * The key tests are the important ones. A storage key is what a presigned URL grants write access to,
 * so a key that can be influenced by a client is a cross-tenant write with a legitimate signature on
 * it.
 */
import { ValidationError } from '@growth-os/errors';
import { describe, expect, it } from 'vitest';
import {
  assertUploadAllowed,
  assertValidStorageKey,
  generateStorageKey,
  policyFor,
  purposeAllows,
  purposes,
} from './policy.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-09-28T12:00:00Z');

const request = (over: Record<string, unknown> = {}) => ({
  purpose: 'media',
  declaredMime: 'image/png',
  originalName: 'photo.png',
  sizeBytes: 1024,
  ...over,
});

describe('storage keys', () => {
  it('generates a key with the organization and the date in it', () => {
    const key = generateStorageKey(ORG, AT);
    expect(key.startsWith(`org/${ORG}/2026/09/`)).toBe(true);
    expect(() => assertValidStorageKey(key)).not.toThrow();
  });

  it('pads the month, so lifecycle prefixes sort', () => {
    expect(generateStorageKey(ORG, new Date('2026-01-05T00:00:00Z'))).toContain('/2026/01/');
  });

  it('never repeats a key', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateStorageKey(ORG, AT)));
    expect(keys.size).toBe(200);
  });

  it('refuses to sign a traversal sequence', () => {
    // The reason keys are server-generated. With a client-influenced key, `../` reaches another
    // tenant's prefix and the presigned URL makes the write legitimate.
    for (const key of [
      `org/${ORG}/2026/09/../../../etc/passwd`,
      `org/${ORG}/2026/09/..`,
      `../org/${ORG}/2026/09/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      `org/${ORG}/2026/09/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/../../x`,
    ]) {
      expect(() => assertValidStorageKey(key), key).toThrow(ValidationError);
    }
  });

  it('refuses a key with an extra segment or a missing one', () => {
    for (const key of [
      'org/2026/09/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      `org/${ORG}/2026/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      `org/${ORG}/2026/09/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/extra`,
      `${ORG}/2026/09/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    ]) {
      expect(() => assertValidStorageKey(key), key).toThrow(ValidationError);
    }
  });

  it('refuses a key carrying a filename or an extension', () => {
    // An extension in the key is what makes a bucket serve a stored object with a type of the
    // uploader's choosing on stores that infer from the key.
    expect(() =>
      assertValidStorageKey(`org/${ORG}/2026/09/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.html`),
    ).toThrow(ValidationError);
  });

  it('refuses an empty key', () => {
    expect(() => assertValidStorageKey('')).toThrow(ValidationError);
  });
});

describe('purpose policies', () => {
  it('declares a policy for every purpose it names', () => {
    for (const purpose of purposes()) {
      expect(policyFor(purpose), purpose).toBeDefined();
    }
  });

  it('gives every purpose a positive cap and a non-empty allowlist', () => {
    for (const purpose of purposes()) {
      const policy = policyFor(purpose);
      expect(policy?.maxBytes, purpose).toBeGreaterThan(0);
      expect(policy?.allowed.length, purpose).toBeGreaterThan(0);
    }
  });

  it('never allows a format for import that the product does not parse', () => {
    // An import is parsed, so a format allowed here must be one whose parser we control. PDF is the
    // one that would otherwise creep in.
    expect(policyFor('import')?.allowed).toEqual(['text/csv', 'text/plain']);
  });

  it('caps each purpose separately', () => {
    // One global cap has to be the largest one, and then applies to the smallest case: a 512 MB limit
    // chosen for video would let a CSV import — which a worker holds — be 512 MB too.
    const media = policyFor('media')?.maxBytes ?? 0;
    const importCap = policyFor('import')?.maxBytes ?? 0;
    expect(importCap).toBeLessThan(media);
  });

  it('decides membership by sniffed type, not declared', () => {
    const media = policyFor('media');
    if (media === undefined) throw new Error('no media policy');
    expect(purposeAllows(media, 'image/png')).toBe(true);
    expect(purposeAllows(media, 'application/pdf')).toBe(false);
  });
});

describe('upload requests', () => {
  it('accepts a well-formed request', () => {
    expect(assertUploadAllowed(request()).purpose).toBe('media');
  });

  it('refuses an unknown purpose', () => {
    expect(() => assertUploadAllowed(request({ purpose: 'whatever' }))).toThrow(/Unknown upload/);
  });

  it('refuses a declared size over the purpose cap', () => {
    // The cheap refusal: one round trip instead of a gigabyte of bucket.
    const cap = policyFor('media')?.maxBytes ?? 0;
    expect(() => assertUploadAllowed(request({ sizeBytes: cap + 1 }))).toThrow(/at most/);
  });

  it('refuses a zero, negative or fractional size', () => {
    for (const sizeBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => assertUploadAllowed(request({ sizeBytes })), String(sizeBytes)).toThrow(
        /positive, whole/,
      );
    }
  });

  it('refuses a filename with a newline', () => {
    // Offered back as a Content-Disposition filename, where a newline is header injection.
    expect(() => assertUploadAllowed(request({ originalName: 'a.png\nX-Evil: 1' }))).toThrow(
      /control characters/,
    );
  });

  it('refuses a filename containing a path separator', () => {
    // A download would write outside the directory the user chose.
    for (const originalName of ['../../etc/passwd', 'dir/file.png', 'dir\\file.png']) {
      expect(() => assertUploadAllowed(request({ originalName })), originalName).toThrow(
        /path separators/,
      );
    }
  });

  it('refuses an empty filename', () => {
    expect(() => assertUploadAllowed(request({ originalName: '   ' }))).toThrow(/must have a name/);
  });
});
