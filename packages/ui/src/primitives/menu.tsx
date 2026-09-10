import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export interface MenuItemSpec {
  readonly id: string;
  readonly label: string;
  readonly onSelect?: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}

export interface MenuProps {
  readonly trigger: ReactNode;
  readonly items: readonly MenuItemSpec[];
  readonly label: string;
  readonly align?: 'start' | 'end';
  readonly className?: string;
}

/**
 * Radix supplies roving tabindex, typeahead, arrow-key navigation and Escape-to-close —
 * the behaviours a hand-rolled menu almost never gets fully right (ADR-0010).
 */
export function Menu({ trigger, items, label, align = 'start', className }: MenuProps) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          className={cx('gos-menu', className)}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
        >
          {items.map((item) => (
            <RadixMenu.Item
              key={item.id}
              className="gos-menu-item"
              {...(item.disabled === undefined ? {} : { disabled: item.disabled })}
              {...(item.onSelect === undefined ? {} : { onSelect: item.onSelect })}
              {...(item.destructive === true ? { style: { color: 'var(--status-negative)' } } : {})}
            >
              {item.label}
            </RadixMenu.Item>
          ))}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}
