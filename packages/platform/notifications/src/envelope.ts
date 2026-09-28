/**
 * The message envelope: what is encrypted, and why all of it is.
 *
 * `outbound_messages.envelope` holds ONE ciphertext covering address, subject and body rather
 * than three columns. Encrypting the body alone would leave the recipient address in plaintext,
 * and the address is both PII and — for an invitation — exactly what an attacker needs in order
 * to know which queued token is worth stealing.
 *
 * The envelope is also the reason this package renders before it queues. Rendering in the sender
 * would mean the sender needed the notification payload, which would mean the payload sat in the
 * queue in the clear; rendering here means the queue holds finished text and the payload never
 * outlives the transaction.
 */
import { ValidationError } from '@growth-os/errors';
import type { MessageCipher } from './ports.js';

export interface MessageEnvelope {
  /** The one address this message may be delivered to. */
  readonly to: string;
  readonly subject: string;
  /** Plain text. A template is chosen by type; there is no caller-supplied markup. */
  readonly body: string;
  /**
   * Carried inside the ciphertext, never as a column.
   *
   * The sender needs it to set a List-Unsubscribe header or a reply-to, and a column would put a
   * second recipient-identifying value in the clear beside the one already encrypted.
   */
  readonly replyTo?: string | undefined;
}

/**
 * A deliberately narrow address check.
 *
 * Not RFC 5322 — that grammar accepts addresses no provider will deliver to and is famously
 * unimplementable in one regexp. This rejects the shapes that are certainly wrong (no `@`, no
 * dot in the domain, whitespace, a newline) and leaves the rest to the provider, which is the
 * only thing that actually knows. The newline case is the one that matters: a newline in an
 * address is header injection, and a queued message is rendered into headers by the sender.
 */
const PLAUSIBLE_ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * True when the text contains a C0 control character or DEL.
 *
 * Written as a code-point scan rather than a character-class regexp on purpose. A regexp
 * containing literal control characters is almost always a mistake — which is why the linter
 * objects to one — and the intent here is easier to read as a range check than as an escape
 * sequence a reader has to decode.
 */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function assertDeliverable(envelope: MessageEnvelope): void {
  for (const [field, value] of [
    ['to', envelope.to],
    ['replyTo', envelope.replyTo],
  ] as const) {
    if (value === undefined) continue;
    if (!PLAUSIBLE_ADDRESS.test(value)) {
      throw new ValidationError(`The ${field} address is not a deliverable address.`);
    }
  }
  // A newline in a subject is header injection: the sender writes the subject into a header, and
  // a second line there becomes a header of the attacker's choosing — a Bcc, for instance.
  if (hasControlCharacter(envelope.subject)) {
    throw new ValidationError('A subject may not contain control characters or newlines.');
  }
  if (envelope.subject.trim().length === 0) {
    throw new ValidationError('A message must have a subject.');
  }
  if (envelope.body.trim().length === 0) {
    throw new ValidationError('A message must have a body.');
  }
}

/** Seals an envelope. The plaintext never reaches the database. */
export function sealEnvelope(cipher: MessageCipher, envelope: MessageEnvelope): Buffer {
  assertDeliverable(envelope);
  return cipher.encrypt(Buffer.from(JSON.stringify(envelope), 'utf8'));
}

/**
 * Opens a sealed envelope, and re-checks it.
 *
 * The re-check is not redundant. Between sealing and opening the ciphertext sat in a table, and
 * while GCM's tag means it cannot have been altered undetectably, a message sealed by an OLDER
 * build may predate a validation rule this one enforces. Sending it would apply the old rules to
 * a message delivered under the new ones.
 */
export function openEnvelope(cipher: MessageCipher, sealed: Buffer): MessageEnvelope {
  const parsed: unknown = JSON.parse(cipher.decrypt(sealed).toString('utf8'));
  if (parsed === null || typeof parsed !== 'object') {
    throw new ValidationError('A sealed envelope did not contain an object.');
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate['to'] !== 'string' ||
    typeof candidate['subject'] !== 'string' ||
    typeof candidate['body'] !== 'string'
  ) {
    throw new ValidationError('A sealed envelope is missing to, subject or body.');
  }
  const replyTo = candidate['replyTo'];
  const envelope: MessageEnvelope = {
    to: candidate['to'],
    subject: candidate['subject'],
    body: candidate['body'],
    ...(typeof replyTo === 'string' ? { replyTo } : {}),
  };
  assertDeliverable(envelope);
  return envelope;
}
