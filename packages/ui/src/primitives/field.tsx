import { forwardRef, type InputHTMLAttributes, type ReactNode, useId } from 'react';
import { cx } from '../lib/cx.js';

export interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly required?: boolean;
  readonly children: (ids: {
    inputId: string;
    describedBy: string | undefined;
    invalid: boolean;
  }) => ReactNode;
}

/**
 * Wires label, hint and error to a control via ids.
 *
 * A field component exists so the wiring cannot be forgotten: an input whose error text is
 * visually adjacent but not referenced by aria-describedby is invisible to a screen reader,
 * and that is the single most common accessibility defect in form UI.
 */
export function Field({ label, hint, error, required, children }: FieldProps) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId]
    .filter((v): v is string => v !== null)
    .join(' ');

  return (
    <div className="gos-field">
      <label className="gos-label" htmlFor={inputId}>
        {label}
        {required === true ? (
          <span aria-hidden="true" style={{ color: 'var(--status-negative)' }}>
            {' '}
            *
          </span>
        ) : null}
      </label>
      {children({
        inputId,
        describedBy: describedBy === '' ? undefined : describedBy,
        invalid: error !== undefined,
      })}
      {hint !== undefined ? (
        <span className="gos-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {/* role="alert" so a validation failure is announced when it appears. */}
      {error !== undefined ? (
        <span className="gos-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx('gos-input', className)} {...rest} />;
});
