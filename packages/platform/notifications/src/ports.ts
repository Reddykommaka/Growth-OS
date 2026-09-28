/**
 * What the notification service depends on, and nothing more.
 *
 * Every one of these is a port rather than an import. The reason is not purity: this package is
 * platform, so it may not import a module, and it must not import a driver either — the cipher
 * lives in @growth-os/authn, the event publisher in @growth-os/events, and depending on both
 * would make the notification service the place where those two packages meet. They meet in the
 * application layer, where the wiring belongs.
 */

export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * Authenticated encryption for a rendered message.
 *
 * Structurally the `SecretCipher` from @growth-os/authn, declared independently so this package
 * does not depend on the authentication layer to send an email. AES-256-GCM in practice: the tag
 * is what makes tampering with a queued message a decryption failure rather than a successfully
 * sent altered message.
 */
export interface MessageCipher {
  encrypt(plaintext: Buffer): Buffer;
  decrypt(ciphertext: Buffer): Buffer;
}

/** Staged in the caller's transaction. Structurally `EventPublisher` from @growth-os/events. */
export interface EventStager {
  stage(event: {
    readonly name: string;
    readonly organizationId: string;
    readonly workspaceId?: string | null | undefined;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly requestId?: string | null | undefined;
    readonly actorUserId?: string | null | undefined;
  }): Promise<string>;
}

export interface Clock {
  now(): Date;
}

/** Supplied so a test can make ids deterministic. Production passes `randomUUID`. */
export interface IdGenerator {
  next(): string;
}
