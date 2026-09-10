import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { describeComponent, renderThemed } from '../testing/a11y.js';
import { Button } from './button.js';

describeComponent(
  'Button',
  {
    render: () => <Button variant="primary">Save changes</Button>,
    states: {
      disabled: () => <Button disabled>Save</Button>,
      loading: () => <Button loading>Save</Button>,
      ghost: () => <Button variant="ghost">Cancel</Button>,
      danger: () => <Button variant="danger">Delete</Button>,
      'icon-only': () => <Button aria-label="Close panel">×</Button>,
    },
  },
  () => {
    it('defaults to type=button so it cannot submit a form by accident', () => {
      renderThemed(<Button>Go</Button>);
      expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
    });

    it('activates on Enter and Space', async () => {
      const onClick = vi.fn();
      const user = userEvent.setup();
      renderThemed(<Button onClick={onClick}>Go</Button>);

      await user.tab();
      expect(screen.getByRole('button')).toHaveFocus();
      await user.keyboard('{Enter}');
      await user.keyboard(' ');
      expect(onClick).toHaveBeenCalledTimes(2);
    });

    it('keeps its accessible name while loading', () => {
      // The name must not become "Loading Save": the spinner label is visually hidden and
      // additive, so it is announced alongside rather than replacing the action.
      renderThemed(<Button loading>Save</Button>);
      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
      expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
    });

    it('suppresses the press while loading', async () => {
      const onClick = vi.fn();
      const user = userEvent.setup();
      renderThemed(
        <Button loading onClick={onClick}>
          Save
        </Button>,
      );
      await user.click(screen.getByRole('button'));
      expect(onClick).not.toHaveBeenCalled();
    });

    it('does not fire when disabled', async () => {
      const onClick = vi.fn();
      const user = userEvent.setup();
      renderThemed(
        <Button disabled onClick={onClick}>
          Save
        </Button>,
      );
      await user.click(screen.getByRole('button'));
      expect(onClick).not.toHaveBeenCalled();
    });

    it('renders as a link when asChild is set, keeping the styling', () => {
      renderThemed(
        <Button asChild variant="primary">
          <a href="/campaigns">Campaigns</a>
        </Button>,
      );
      const link = screen.getByRole('link', { name: 'Campaigns' });
      expect(link).toHaveClass('gos-button', 'gos-button--primary');
      expect(link).not.toHaveAttribute('type');
    });
  },
);
