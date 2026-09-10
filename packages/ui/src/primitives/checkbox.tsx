import * as RadixCheckbox from '@radix-ui/react-checkbox';
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';
import { cx } from '../lib/cx.js';

export type CheckboxProps = ComponentPropsWithoutRef<typeof RadixCheckbox.Root>;

/**
 * Radix supplies the behaviour — space toggles, the indeterminate tri-state, the hidden
 * native input that makes it work inside a form. Hand-rolling those is where checkbox
 * accessibility usually breaks (ADR-0010).
 */
export const Checkbox = forwardRef<ElementRef<typeof RadixCheckbox.Root>, CheckboxProps>(
  function Checkbox({ className, ...rest }, ref) {
    return (
      <RadixCheckbox.Root ref={ref} className={cx('gos-checkbox', className)} {...rest}>
        <RadixCheckbox.Indicator className="gos-checkbox-indicator">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <path
              d="M1.5 5.2 3.8 7.5 8.5 2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
    );
  },
);
