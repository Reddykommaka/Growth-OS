/**
 * The catalogue's invariants.
 *
 * Two of these are security properties rather than tidiness. A type that writes no inbox row and
 * has no channels is a notification that goes nowhere; and a security notice the recipient can
 * switch off is the one message an attacker who has taken an account wants silenced.
 */
import { describe, expect, it } from 'vitest';
import { notificationType, notificationTypeKeys, unknownNotificationTypes } from './catalogue.js';

const all = () => notificationTypeKeys().map((key) => notificationType(key));

describe('the notification catalogue', () => {
  it('declares every key exactly once', () => {
    const keys = notificationTypeKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('names each type after the module that owns it', () => {
    for (const declared of all()) {
      expect(declared?.key.startsWith(`${declared.module}.`), declared?.key).toBe(true);
    }
  });

  it('never declares a type that goes nowhere', () => {
    // No inbox row and no channel is a notification nobody ever sees — which would pass every
    // other test in this file and every test that sends it.
    for (const declared of all()) {
      expect(declared?.inApp === true || (declared?.channels.length ?? 0) > 0, declared?.key).toBe(
        true,
      );
    }
  });

  it('makes every security notice mandatory', () => {
    // An attacker who has taken an account silences the message that reveals it, if they can.
    // These four are the ones that reveal it.
    for (const key of [
      'identity.password.changed',
      'identity.mfa.changed',
      'identity.session.new_device',
      'identity.api_key.created',
    ]) {
      expect(notificationType(key)?.mandatory, key).toBe(true);
    }
  });

  it('gives every mandatory type a channel that leaves the product', () => {
    // A mandatory notice delivered only in-app is one the attacker simply does not open. The
    // point of mandatory is that it reaches somewhere they do not control.
    for (const declared of all()) {
      if (declared?.mandatory === true) {
        expect(declared.channels.length, declared.key).toBeGreaterThan(0);
      }
    }
  });

  it('declares the invitation type as channel-only', () => {
    // The type that forced the outbound queue to be addressed by channel rather than by user:
    // its recipient has no account yet, so there is nobody to give an inbox row to.
    const invitation = notificationType('organization.invitation.sent');
    expect(invitation?.inApp).toBe(false);
    expect(invitation?.channels).toEqual(['email']);
    expect(invitation?.mandatory).toBe(true);
  });

  it('covers the products and the platform', () => {
    const modules = new Set(all().map((t) => t?.module));
    for (const module of [
      'identity',
      'organization',
      'billing',
      'social',
      'marketing',
      'marketplace',
      'platform',
    ]) {
      expect(modules, module).toContain(module);
    }
  });

  it('reports an unknown key rather than resolving it to something', () => {
    expect(notificationType('social.post.imaginary')).toBeUndefined();
    expect(unknownNotificationTypes(['social.post.imaginary', ...notificationTypeKeys()])).toEqual([
      'social.post.imaginary',
    ]);
  });
});
