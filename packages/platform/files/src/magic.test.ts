/**
 * Magic-byte sniffing.
 *
 * This is the file where the security value of the package lives, so it is the file with the
 * adversarial cases. Every test named "refuses" describes an upload that would otherwise be stored
 * under a type that makes it dangerous — which, per 10-security-architecture.md §3, is the reason the
 * allowlist is checked against bytes and not against the uploader's word.
 */
import { describe, expect, it } from 'vitest';
import { declarationMismatches, SNIFF_BYTES, sniff } from './magic.js';

const bytes = (...values: number[]): Buffer => Buffer.from(values);
const text = (value: string): Buffer => Buffer.from(value, 'latin1');

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46);
const GIF = text('GIF89a\u0001\u0000');
const WEBP = Buffer.concat([text('RIFF'), bytes(0, 0, 0, 0), text('WEBPVP8 ')]);
const MP4 = Buffer.concat([bytes(0, 0, 0, 0x20), text('ftypisom'), bytes(0, 0, 2, 0)]);
const PDF = text('%PDF-1.7\n1 0 obj');

describe('recognised formats', () => {
  it('identifies each allowed binary format from its signature', () => {
    expect(sniff(PNG, 'image/png').type).toBe('image/png');
    expect(sniff(JPEG, 'image/jpeg').type).toBe('image/jpeg');
    expect(sniff(GIF, 'image/gif').type).toBe('image/gif');
    expect(sniff(WEBP, 'image/webp').type).toBe('image/webp');
    expect(sniff(MP4, 'video/mp4').type).toBe('video/mp4');
    expect(sniff(PDF, 'application/pdf').type).toBe('application/pdf');
  });

  it('identifies GIF87a as well as GIF89a', () => {
    expect(sniff(text('GIF87a\u0001\u0000'), 'image/gif').type).toBe('image/gif');
  });

  it('identifies a JPEG whatever its first marker is', () => {
    // JFIF, Exif and raw all differ at the third byte. A signature pinned to one of them would
    // reject two thirds of real photographs.
    for (const marker of [0xe0, 0xe1, 0xdb, 0xee]) {
      expect(sniff(bytes(0xff, 0xd8, 0xff, marker, 0, 0), 'image/jpeg').type, String(marker)).toBe(
        'image/jpeg',
      );
    }
  });

  it('accepts text, choosing between csv and plain by the declaration', () => {
    // The ONLY place the declaration influences the outcome, and it can only pick between two types
    // that are the same bytes.
    expect(sniff(text('a,b,c\n1,2,3\n'), 'text/csv').type).toBe('text/csv');
    expect(sniff(text('a,b,c\n1,2,3\n'), 'text/plain').type).toBe('text/plain');
  });

  it('accepts text containing tabs and newlines', () => {
    expect(sniff(text('a\tb\r\nc\td\n'), 'text/csv').type).toBe('text/csv');
  });
});

describe('what it refuses', () => {
  it('refuses an empty file', () => {
    expect(sniff(Buffer.alloc(0), 'image/png')).toMatchObject({ type: undefined });
  });

  it('refuses a binary file that matches nothing', () => {
    // The allowlist is positive. "Unrecognised, probably fine" is how a polyglot gets in.
    const result = sniff(bytes(0x00, 0x01, 0x02, 0xfe, 0xff, 0x7f), 'application/octet-stream');
    expect(result.type).toBeUndefined();
    expect(result.reason).toContain('positive');
  });

  it('refuses an executable declared as an image', () => {
    // ELF and PE, the two that matter. Believing the declaration would store either as image/png.
    const elf = bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00);
    const pe = text('MZ\u0090\u0000\u0003\u0000\u0000\u0000');
    expect(sniff(elf, 'image/png').type).toBeUndefined();
    expect(sniff(pe, 'image/png').type).toBeUndefined();
  });

  it('refuses a zip, and therefore an office document or a jar', () => {
    // A container we do not inspect is a container we cannot vouch for.
    expect(sniff(text('PK\u0003\u0004'), 'application/zip').type).toBeUndefined();
  });

  it('refuses HTML however it is declared', () => {
    // Stored HTML served from an origin holding session cookies is stored XSS. The separate-origin
    // rule is the second layer; this is the first.
    for (const declared of ['text/plain', 'text/csv', 'text/html', 'image/png']) {
      const result = sniff(text('<!DOCTYPE html><html><body>hi'), declared);
      expect(result.type, declared).toBeUndefined();
      expect(result.reason, declared).toContain('Markup');
    }
  });

  it('refuses SVG, which is the case the architecture calls out by name', () => {
    // 10 §3: "no user-supplied SVG rendered inline". An SVG stored as text/plain is exactly how one
    // gets rendered anyway, so it is refused at the gate rather than trusted to be served carefully.
    expect(
      sniff(text('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'text/plain').type,
    ).toBeUndefined();
    expect(sniff(text('<?xml version="1.0"?><svg/>'), 'image/svg+xml').type).toBeUndefined();
  });

  it('refuses markup with leading whitespace', () => {
    // A check anchored at byte zero would miss every one of these, and a prettifier adds them.
    for (const prefix of [' ', '\n', '\r\n\t', '   \n  ']) {
      expect(
        sniff(text(`${prefix}<html>`), 'text/plain').type,
        JSON.stringify(prefix),
      ).toBeUndefined();
    }
  });

  it('refuses a bare script tag', () => {
    expect(sniff(text('<script>fetch("/steal")</script>'), 'text/plain').type).toBeUndefined();
  });

  it('refuses text containing a NUL byte', () => {
    // A NUL means binary, whatever the extension says — and a truncating parser downstream would read
    // only the harmless prefix.
    expect(sniff(text('id,name\n1,ok\u0000\u0001\u0002'), 'text/csv').type).toBeUndefined();
  });

  it('refuses a WAV file that shares the RIFF header with WebP', () => {
    // RIFF is a family, not a format. A single-signature check on `RIFF` alone would store a WAV as
    // an image — which is the bug that makes a two-part signature worth the complexity.
    const wav = Buffer.concat([text('RIFF'), bytes(0, 0, 0, 0), text('WAVEfmt ')]);
    expect(sniff(wav, 'image/webp').type).toBeUndefined();
  });

  it('refuses a truncated binary signature rather than guessing', () => {
    // A PNG header cut in half starts 0x89, which is a UTF-8 continuation byte with nothing to
    // continue — so it is binary, and binary that matches no signature is refused.
    expect(sniff(bytes(0x89, 0x50), 'image/png').type).toBeUndefined();
  });

  it('does not promote a truncated container to the format it was going to be', () => {
    // Four bytes of `RIFF` genuinely ARE text, so refusing them outright would be wrong. What must
    // not happen is accepting them as the image the client declared.
    expect(sniff(text('RIFF'), 'image/webp').type).not.toBe('image/webp');
  });

  it('refuses binary made of high bytes, which a printable-ASCII check would accept', () => {
    // The loophole UTF-8 validation closes. Every byte here is above 0x7f, so a control-character
    // check alone passes it and the blob is stored as text/plain.
    expect(sniff(bytes(0xff, 0xfe, 0x80, 0x81, 0x82, 0x83), 'text/csv').type).toBeUndefined();
    expect(sniff(bytes(0xc0, 0xc1, 0xf5, 0xff), 'text/plain').type).toBeUndefined();
  });

  it('refuses a lone continuation byte', () => {
    expect(sniff(bytes(0x41, 0x80, 0x42), 'text/csv').type).toBeUndefined();
  });

  it('accepts text in a language that needs multi-byte characters', () => {
    // The reason high bytes are not simply banned: this is an ordinary CSV.
    for (const value of ['nom,ville\nJosé,Málaga\n', 'なまえ,まち\n', 'имя,город\n']) {
      expect(sniff(Buffer.from(value, 'utf8'), 'text/csv').type, value).toBe('text/csv');
    }
  });

  it('accepts text whose last character is cut by the sniff window', () => {
    // A ranged read can split a multi-byte character, and calling that file invalid would reject a
    // perfectly good one.
    const full = Buffer.from('ключ,значение\n', 'utf8');
    for (let cut = 1; cut <= full.length; cut++) {
      const head = full.subarray(0, cut);
      // Only the truncation cases matter; a cut that lands mid-character must still read as text.
      expect(sniff(head, 'text/csv').type, `cut at ${cut}`).toBe('text/csv');
    }
  });
});

describe('declaration mismatch', () => {
  it('reports a real disagreement', () => {
    // Kept as a signal rather than a refusal: the file is allowed, and a pattern of mismatches from
    // one organization is worth seeing.
    expect(declarationMismatches('image/png', 'image/jpeg')).toBe(true);
    expect(declarationMismatches('application/pdf', 'image/png')).toBe(true);
  });

  it('does not report agreement', () => {
    expect(declarationMismatches('image/png', 'image/png')).toBe(false);
  });

  it('does not report csv against plain, which are the same bytes', () => {
    expect(declarationMismatches('text/csv', 'text/plain')).toBe(false);
    expect(declarationMismatches('text/plain', 'text/csv')).toBe(false);
  });
});

describe('the sniff window', () => {
  it('is large enough for every signature it checks', () => {
    // MP4 reads at offset 4..12 and WebP at 8..12; a window smaller than that would silently stop
    // recognising containers while still recognising PNG, so every test above would still pass.
    expect(SNIFF_BYTES).toBeGreaterThanOrEqual(12);
    expect(sniff(MP4.subarray(0, SNIFF_BYTES), 'video/mp4').type).toBe('video/mp4');
    expect(sniff(WEBP.subarray(0, SNIFF_BYTES), 'image/webp').type).toBe('image/webp');
  });
});
