import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { describeComponent, renderThemed } from '../testing/a11y.js';
import { Button } from './button.js';
import { Tooltip, TooltipProvider } from './tooltip.js';

const tooltip = () => (
  <TooltipProvider>
    <Tooltip content="Publishes to every connected account">
      <Button>Publish</Button>
    </Tooltip>
  </TooltipProvider>
);

describeComponent('Tooltip', { render: tooltip }, () => {
  it('shows on keyboard focus, not only on hover', async () => {
    // A tooltip that appears only on hover is unreachable by keyboard and by touch.
    const user = userEvent.setup();
    renderThemed(tooltip());

    await user.tab();
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveFocus();
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent('Publishes to every connected account'),
    );
  });

  it('announces its content to assistive technology as well as showing it', async () => {
    // Radix renders the text twice on purpose: the visible bubble, plus a visually hidden
    // live region. Both are wanted — the bubble is invisible to a screen reader.
    const user = userEvent.setup();
    renderThemed(tooltip());
    await user.tab();
    await waitFor(() =>
      expect(
        screen.getAllByText('Publishes to every connected account').length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it('leaves the trigger with its own accessible name', () => {
    // The tooltip supplements the control; it must not become its name
    // (13-design-system.md §5).
    renderThemed(tooltip());
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
  });

  it('hides on Escape', async () => {
    const user = userEvent.setup();
    renderThemed(tooltip());
    await user.tab();
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });
});
