import * as RadixSelect from '@radix-ui/react-select';
import { cx } from '../lib/cx.js';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly options: readonly SelectOption[];
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly placeholder?: string;
  readonly label: string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly describedBy?: string;
  readonly className?: string;
}

export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = 'Select…',
  label,
  id,
  disabled,
  invalid,
  describedBy,
  className,
}: SelectProps) {
  return (
    <RadixSelect.Root
      {...(value === undefined ? {} : { value })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      {...(onValueChange === undefined ? {} : { onValueChange })}
      {...(disabled === undefined ? {} : { disabled })}
    >
      <RadixSelect.Trigger
        id={id}
        className={cx('gos-select-trigger', className)}
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={describedBy}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <path
              d="M2.5 4 5 6.5 7.5 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="gos-select-content" position="popper" sideOffset={4}>
          <RadixSelect.Viewport className="gos-select-viewport">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                className="gos-select-item"
                value={option.value}
                {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
              >
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
