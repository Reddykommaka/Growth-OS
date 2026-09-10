import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { describeComponent, renderThemed } from '../testing/a11y.js';
import { Checkbox } from './checkbox.js';

describeComponent(
  'Checkbox',
  {
    render: () => <Checkbox aria-label="Include archived" />,
    states: {
      checked: () => <Checkbox aria-label="Include archived" defaultChecked />,
      indeterminate: () => <Checkbox aria-label="Select all" checked="indeterminate" />,
      disabled: () => <Checkbox aria-label="Locked" disabled />,
    },
  },
  () => {
    it('toggles with the space key', async () => {
      const user = userEvent.setup();
      renderThemed(<Checkbox aria-label="Include archived" />);
      const box = screen.getByRole('checkbox', { name: 'Include archived' });

      await user.tab();
      expect(box).toHaveFocus();
      await user.keyboard(' ');
      expect(box).toBeChecked();
      await user.keyboard(' ');
      expect(box).not.toBeChecked();
    });

    it('reports an indeterminate state as mixed, not as checked', () => {
      renderThemed(<Checkbox aria-label="Select all" checked="indeterminate" />);
      expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'mixed');
    });

    it('does not toggle when disabled', async () => {
      const onCheckedChange = vi.fn();
      const user = userEvent.setup();
      renderThemed(<Checkbox aria-label="Locked" disabled onCheckedChange={onCheckedChange} />);
      await user.click(screen.getByRole('checkbox'));
      expect(onCheckedChange).not.toHaveBeenCalled();
    });
  },
);
