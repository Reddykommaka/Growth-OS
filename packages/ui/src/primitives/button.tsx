import { Slot, Slottable } from '@radix-ui/react-slot';
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /**
   * While loading the button stays focusable and keeps its accessible name; only the press
   * is suppressed. Removing it from the tab order mid-interaction strands a keyboard user.
   */
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  /** Renders the child element instead of a <button>, keeping behaviour and styling. */
  readonly asChild?: boolean;
  readonly children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    loadingLabel = 'Loading',
    asChild = false,
    className,
    children,
    disabled,
    type,
    ...rest
  },
  ref,
) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      ref={ref}
      // An unset type inside a form defaults to "submit", which silently submits on click.
      type={asChild ? undefined : (type ?? 'button')}
      className={cx(
        'gos-button',
        `gos-button--${variant}`,
        size !== 'md' && `gos-button--${size}`,
        className,
      )}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      {...rest}
    >
      {/*
        Slottable is required for the asChild path: Slot accepts exactly one child, so
        rendering the spinner as a sibling of `children` would throw. Slottable marks which
        child the slotted element replaces, letting the spinner sit alongside it.
      */}
      {loading ? (
        <>
          <span className="gos-spinner" aria-hidden="true" />
          <span className="gos-visually-hidden">{loadingLabel}</span>
        </>
      ) : null}
      <Slottable>{children}</Slottable>
    </Component>
  );
});
