import * as RadixPopover from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export interface PopoverProps {
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly align?: 'start' | 'center' | 'end';
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  readonly className?: string;
  /** Popovers holding only static content need no accessible name of their own. */
  readonly label?: string;
}

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = 'start',
  side = 'bottom',
  className,
  label,
}: PopoverProps) {
  return (
    <RadixPopover.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={cx('gos-popover', className)}
          align={align}
          side={side}
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
