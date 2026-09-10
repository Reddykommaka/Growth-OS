import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export interface TooltipProps {
  readonly content: string;
  readonly children: ReactNode;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  readonly delayMs?: number;
}

/** Wrap the app once so tooltips share a hover-delay group. */
export const TooltipProvider = RadixTooltip.Provider;

/**
 * A tooltip is supplementary, never the only source of information: it is unavailable to
 * touch users and is dismissed on blur. Anything essential belongs in visible text or in
 * the control's accessible name (13-design-system.md §5).
 */
export function Tooltip({ content, children, side = 'top', delayMs = 300 }: TooltipProps) {
  return (
    <RadixTooltip.Root delayDuration={delayMs}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="gos-tooltip" side={side} sideOffset={4}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
