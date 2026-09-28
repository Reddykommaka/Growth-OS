/**
 * What the bytes actually are.
 *
 * 10-security-architecture.md §3: "MIME allowlist verified by magic bytes not extension". The
 * distinction is the whole point. A `Content-Type` header and a filename extension are both
 * supplied by the uploader, so trusting either means the uploader chooses how their file will later
 * be served — and a file served as `text/html` from a domain that holds session cookies is stored
 * XSS. (The separate-origin rule in §3 is the second layer; this is the first.)
 *
 * SNIFFING IS AN ALLOWLIST, NOT A GUESS. Anything this module cannot positively identify as one of
 * the declared types is refused. The alternative — "probably text, allow it" — is how a polyglot
 * file gets in: a payload that is valid in two formats at once, stored under the harmless one.
 */

export type SniffedType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'application/pdf'
  | 'video/mp4'
  | 'text/csv'
  | 'text/plain';

/** A byte signature at a fixed offset. `undefined` in the pattern matches any byte. */
interface Signature {
  readonly type: SniffedType;
  readonly offset: number;
  readonly bytes: readonly (number | undefined)[];
  /** A second signature that must also hold — for containers whose first bytes are a length. */
  readonly also?: { readonly offset: number; readonly bytes: readonly number[] };
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

const SIGNATURES: readonly Signature[] = [
  { type: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // JFIF/Exif/raw JPEG all start SOI; the third byte is the first marker and varies.
  { type: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', offset: 0, bytes: ascii('GIF87a') },
  { type: 'image/gif', offset: 0, bytes: ascii('GIF89a') },
  /*
   * WebP and MP4 are both containers whose first bytes are a size, so each needs two checks. A
   * single-signature check on `RIFF` alone would accept a WAV file as an image — RIFF is a family,
   * not a format, and the format is the four bytes at offset 8.
   */
  {
    type: 'image/webp',
    offset: 0,
    bytes: ascii('RIFF'),
    also: { offset: 8, bytes: ascii('WEBP') },
  },
  {
    type: 'video/mp4',
    offset: 4,
    bytes: ascii('ftyp'),
    also: { offset: 4, bytes: ascii('ftyp') },
  },
  { type: 'application/pdf', offset: 0, bytes: ascii('%PDF-') },
];

/** Enough for every signature above plus the offsets they read at. */
export const SNIFF_BYTES = 64;

function matches(head: Buffer, signature: Signature): boolean {
  const end = signature.offset + signature.bytes.length;
  if (head.length < end) return false;
  for (const [index, expected] of signature.bytes.entries()) {
    if (expected === undefined) continue;
    if (head[signature.offset + index] !== expected) return false;
  }
  if (signature.also !== undefined) {
    const alsoEnd = signature.also.offset + signature.also.bytes.length;
    if (head.length < alsoEnd) return false;
    for (const [index, expected] of signature.also.bytes.entries()) {
      if (head[signature.also.offset + index] !== expected) return false;
    }
  }
  return true;
}

/**
 * Whether the head is something we are willing to call text.
 *
 * Two conditions, and the second is the one that took a test to find.
 *
 * 1. NO CONTROL CHARACTERS other than tab, newline and carriage return. A NUL means binary whatever
 *    the extension says, and a truncating parser downstream would read only the harmless prefix.
 *
 * 2. VALID UTF-8. A printable-ASCII check alone accepts every byte from 0x80 to 0xFF, so a binary
 *    blob made of high bytes would be stored as `text/plain` — which is the loophole this whole
 *    module exists to close. Rejecting high bytes outright is not the answer either: it would refuse
 *    every CSV containing a non-English name. UTF-8 validity is the check that admits real text in
 *    any language and rejects arbitrary bytes, because a random byte sequence is almost never valid
 *    UTF-8.
 */
function looksLikeText(head: Buffer): boolean {
  for (const byte of head) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) return false;
  }
  return isValidUtf8(head);
}

/** Bytes in a UTF-8 sequence led by this byte, or 0 when it cannot lead one. */
function utf8Width(byte: number): number {
  if (byte < 0x80) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
}

/**
 * UTF-8 validation over a possibly-truncated buffer.
 *
 * `TextDecoder('utf-8', { fatal: true })` would be shorter and is wrong here: the head is the first
 * 64 bytes of a larger file, so a multi-byte character can be cut in half at the boundary and a fatal
 * decode would call a perfectly good file invalid. An incomplete sequence at the very END is
 * therefore accepted; an incomplete one anywhere else is not.
 */
function isValidUtf8(head: Buffer): boolean {
  let index = 0;
  while (index < head.length) {
    const byte = head[index];
    if (byte === undefined) return false;

    const width = utf8Width(byte);
    // 0 means the byte encodes nothing valid: 0x80–0xBF is a continuation with nothing to continue,
    // and 0xC0/0xC1/0xF5–0xFF are never legal lead bytes. Both are the signature of binary data.
    if (width === 0) return false;

    if (index + width > head.length) {
      // Truncated at the boundary. Every byte so far was valid, so the file is text as far as we can
      // tell — which is the most an ranged read can establish.
      return true;
    }
    for (let offset = 1; offset < width; offset++) {
      const continuation = head[index + offset];
      if (continuation === undefined || continuation < 0x80 || continuation > 0xbf) return false;
    }
    index += width;
  }
  return true;
}

/**
 * Markup that must not be stored as text, however text-like the bytes are.
 *
 * A file whose first non-whitespace bytes open an HTML or XML document is a document, not data, and
 * `text/plain` is how it gets past an allowlist and served somewhere it will be parsed. SVG is the
 * case that matters most — 10 §3 forbids rendering user-supplied SVG inline, and an SVG stored as
 * `text/plain` is exactly how one gets rendered anyway.
 */
const MARKUP_OPENERS = ['<!doctype', '<html', '<svg', '<?xml', '<script'];

function opensMarkup(head: Buffer): boolean {
  const start = head.toString('latin1').trimStart().slice(0, 64).toLowerCase();
  return MARKUP_OPENERS.some((opener) => start.startsWith(opener));
}

export interface SniffResult {
  readonly type: SniffedType | undefined;
  /** Why nothing was identified. Operator-facing; never shown to the uploader verbatim. */
  readonly reason?: string;
}

/**
 * Identifies the head of a file, or refuses it.
 *
 * `declaredMime` is used for ONE thing only: choosing between `text/csv` and `text/plain`, which are
 * indistinguishable by bytes. It never widens what is accepted — a declared `image/png` over
 * text bytes is refused, not believed.
 */
export function sniff(head: Buffer, declaredMime: string): SniffResult {
  if (head.length === 0) return { type: undefined, reason: 'the file is empty' };

  for (const signature of SIGNATURES) {
    if (matches(head, signature)) return { type: signature.type };
  }

  if (opensMarkup(head)) {
    return {
      type: undefined,
      reason:
        'the file opens an HTML, XML or SVG document. Markup is refused because a stored document ' +
        'can be served somewhere it will be parsed (10-security-architecture.md §3).',
    };
  }

  if (looksLikeText(head)) {
    // The only place the declaration is consulted, and it can only choose between two text types.
    return { type: declaredMime === 'text/csv' ? 'text/csv' : 'text/plain' };
  }

  return {
    type: undefined,
    reason:
      'the bytes match no allowed format. The allowlist is positive: unrecognised is refused.',
  };
}

/** True when the sniffed type contradicts what the uploader claimed. */
export const declarationMismatches = (sniffed: SniffedType, declaredMime: string): boolean =>
  // text/csv and text/plain are the same bytes, so disagreeing between them is not a mismatch.
  !(sniffed === declaredMime || (sniffed.startsWith('text/') && declaredMime.startsWith('text/')));
