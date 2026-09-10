import * as RadixTabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cx } from '../lib/cx.js';

export interface TabSpec {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
  readonly disabled?: boolean;
}

export interface TabsProps {
  readonly tabs: readonly TabSpec[];
  readonly defaultTab?: string;
  readonly value?: string;
  readonly onValueChange?: (value: string) => void;
  readonly label: string;
  readonly className?: string;
}

export function Tabs({ tabs, defaultTab, value, onValueChange, label, className }: TabsProps) {
  const defaultValue = defaultTab ?? tabs[0]?.id;
  return (
    <RadixTabs.Root
      className={className}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      {...(value === undefined ? {} : { value })}
      {...(onValueChange === undefined ? {} : { onValueChange })}
    >
      <RadixTabs.List className={cx('gos-tabs-list')} aria-label={label}>
        {tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.id}
            className="gos-tab"
            value={tab.id}
            {...(tab.disabled === undefined ? {} : { disabled: tab.disabled })}
          >
            {tab.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {tabs.map((tab) => (
        <RadixTabs.Content key={tab.id} className="gos-tab-panel" value={tab.id}>
          {tab.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
