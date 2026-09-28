/**
 * The sealed envelope.
 *
 * The header-injection cases are the reason this file exists. A queued message is rendered into
 * SMTP headers by the sender, so a newline in a subject or an address is a header of the
 * attacker's choosing — a `Bcc:` being the obvious one — and the message that carries it is
 * otherwise entirely legitimate.
 */
import { createSecretCipher, generateSecretKey } from '@growth-os/authn';
import { describe, expect, it } from 'vitest';
import { assertDeliverable, type MessageEnvelope, openEnvelope, sealEnvelope } from './envelope.js';

const cipher = createSecretCipher(generateSecretKey());

const envelope = (over: Partial<MessageEnvelope> = {}): MessageEnvelope => ({
  to: 'invitee@example.com',
  subject: 'Join Acme on Growth OS',
  body: 'Open this link to accept.',
  ...over,
});

describe('address validation', () => {
  it('accepts an ordinary address', () => {
    expect(() => assertDeliverable(envelope())).not.toThrow();
  });

  it('refuses an address with no @ or no dotted domain', () => {
    for (const to of ['nobody', 'nobody@localhost', '@example.com', 'a@b']) {
      expect(() => assertDeliverable(envelope({ to })), to).toThrow(/deliverable/);
    }
  });

  it('refuses an address carrying a newline', () => {
    // Header injection. The sender writes this into a `To:` header, and a second line there is a
    // header the attacker chose.
    for (const to of ['a@b.com\nBcc: victim@example.com', 'a@b.com\r\nBcc: v@e.com']) {
      expect(() => assertDeliverable(envelope({ to })), JSON.stringify(to)).toThrow(/deliverable/);
    }
  });

  it('refuses an address list where one address is expected', () => {
    // "the ONLY address this may be delivered to" is a property of the port. A comma would make
    // one queued invitation deliver its token to two people.
    for (const to of ['a@b.com,c@d.com', 'a@b.com;c@d.com']) {
      expect(() => assertDeliverable(envelope({ to })), to).toThrow(/deliverable/);
    }
  });

  it('applies the same rule to replyTo', () => {
    expect(() => assertDeliverable(envelope({ replyTo: 'x@y.com\nBcc: v@e.com' }))).toThrow(
      /replyTo/,
    );
  });
});

describe('subject and body validation', () => {
  it('refuses a subject carrying a newline or a control character', () => {
    for (const subject of ['Hello\nBcc: v@e.com', 'Hello\r\nX-Header: y', 'Hello\u0000there']) {
      expect(() => assertDeliverable(envelope({ subject })), JSON.stringify(subject)).toThrow(
        /control characters/,
      );
    }
  });

  it('refuses an empty subject or body', () => {
    expect(() => assertDeliverable(envelope({ subject: '   ' }))).toThrow(/subject/);
    expect(() => assertDeliverable(envelope({ body: '\n\n' }))).toThrow(/body/);
  });

  it('allows newlines in the body, which is where they belong', () => {
    expect(() => assertDeliverable(envelope({ body: 'line one\nline two' }))).not.toThrow();
  });
});

describe('sealing', () => {
  it('round-trips an envelope', () => {
    const original = envelope({ replyTo: 'support@example.com' });
    expect(openEnvelope(cipher, sealEnvelope(cipher, original))).toEqual(original);
  });

  it('leaves no plaintext in the ciphertext', () => {
    // The whole envelope is encrypted, not just the body: the address is both PII and, for an
    // invitation, exactly what an attacker needs in order to know which queued token to steal.
    const sealed = sealEnvelope(cipher, envelope({ body: 'token abc123' }));
    const text = sealed.toString('binary');
    for (const secret of ['invitee@example.com', 'abc123', 'Join Acme']) {
      expect(text.includes(secret), secret).toBe(false);
    }
  });

  it('refuses to seal an undeliverable envelope', () => {
    // Validated on the way IN as well as out, so a bad message never reaches the queue at all.
    expect(() => sealEnvelope(cipher, envelope({ to: 'nope' }))).toThrow(/deliverable/);
  });

  it('detects a tampered ciphertext rather than decrypting to something else', () => {
    const sealed = sealEnvelope(cipher, envelope());
    // GCM's tag is the reason this is a failure and not a successfully sent altered message.
    const tampered = Buffer.from(sealed);
    const index = tampered.length - 1;
    const before = tampered[index];
    if (before === undefined) throw new Error('empty ciphertext');
    tampered[index] = before ^ 0xff;
    expect(() => openEnvelope(cipher, tampered)).toThrow();
  });

  it('refuses an envelope sealed under a different key', () => {
    const other = createSecretCipher(generateSecretKey());
    expect(() => openEnvelope(cipher, sealEnvelope(other, envelope()))).toThrow();
  });

  it('re-validates on open, so an older build cannot smuggle a message past a new rule', () => {
    // A message sealed before a validation rule existed would otherwise be delivered under the
    // old rules. Simulated by sealing the JSON directly, bypassing the write-side check.
    const smuggled = cipher.encrypt(
      Buffer.from(JSON.stringify({ to: 'a@b.com', subject: 'x\nBcc: v@e.com', body: 'y' })),
    );
    expect(() => openEnvelope(cipher, smuggled)).toThrow(/control characters/);
  });

  it('refuses a sealed payload that is not an envelope', () => {
    for (const junk of ['null', '"a string"', '{"to":"a@b.com"}', '[]']) {
      expect(() => openEnvelope(cipher, cipher.encrypt(Buffer.from(junk))), junk).toThrow();
    }
  });
});
