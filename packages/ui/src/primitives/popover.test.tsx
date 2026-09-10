import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { describeComponent, renderThemed } from '../testing/a11y.js';
import { Button } from './button.js';
import { Popover } from './popover.js';

const popover = () => (
  <Popover label="Filters" trigger={<Button>Filters</Button>}>
    <label htmlFor="q">Query</label>
    <input id="q" />
  </Popover>
);

describeComponent('Popover', { render: popover }, () => {
  it('is closed until the trigger is activated', () => {
    renderThemed(popover());
    expect(screen.queryByLabelText('Query')).not.toBeInTheDocument();
  });

  it('opens from the keyboard', async () => {
    const user = userEvent.setup();
    renderThemed(popover());
    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByLabelText('Query')).toBeInTheDocument());
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderThemed(popover());
    const trigger = screen.getByRole('button', { name: 'Filters' });

    await user.click(trigger);
    await waitFor(() => expect(screen.getByLabelText('Query')).toBeInTheDocument());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('Query')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('marks the trigger expanded state for assistive technology', async () => {
    const user = userEvent.setup();
    renderThemed(popover());
    const trigger = screen.getByRole('button', { name: 'Filters' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
  });
});
