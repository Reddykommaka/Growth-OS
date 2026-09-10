import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export interface DialogProps {
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly trigger?: ReactNode;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}

/**
 * Radix supplies the focus trap, scroll lock, Escape handling and return-focus-on-close.
 * A dialog is the component where hand-rolled accessibility fails most often and most
 * visibly — a keyboard user tabbing out of an open modal is stranded (ADR-0010).
 *
 * `title` is required, not optional: Radix warns when a dialog has no accessible name, and
 * an unnamed dialog is announced as nothing at all.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  children,
  footer,
  className,
}: DialogProps) {
  return (
    <RadixDialog.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      {trigger === undefined ? null : <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="gos-overlay" />
        <RadixDialog.Content className={cx('gos-dialog', className)}>
          <RadixDialog.Title className="gos-dialog-title">{title}</RadixDialog.Title>
          {description === undefined ? (
            // Radix requires either a description or an explicit opt-out; without one it
            // logs a warning and the dialog has no described-by target.
            <RadixDialog.Description className="gos-visually-hidden">
              {title}
            </RadixDialog.Description>
          ) : (
            <RadixDialog.Description className="gos-dialog-description">
              {description}
            </RadixDialog.Description>
          )}
          {children}
          {footer === undefined ? null : (
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 'var(--space-2)',
                marginTop: 'var(--space-5)',
              }}
            >
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
