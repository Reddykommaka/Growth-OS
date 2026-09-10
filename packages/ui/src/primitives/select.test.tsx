import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { describeComponent, renderThemed } from '../testing/a11y.js';
import { Select } from './select.js';

const options = [
  { value: 'draft', label: 'Draft' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'published', label: 'Published' },
  { value: 'archived', label: 'Archived', disabled: true },
];

describeComponent(
  'Select',
  {
    render: () => <Select options={options} label="Status" />,
    states: {
      'with-value': () => <Select options={options} label="Status" defaultValue="scheduled" />,
      disabled: () => <Select options={options} label="Status" disabled />,
      invalid: () => <Select options={options} label="Status" invalid />,
    },
  },
  () => {
    it('exposes a combobox with an accessible name', () => {
      renderThemed(<Select options={options} label="Status" />);
      expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    });

    it('shows the placeholder until a value is chosen', () => {
      renderThemed(<Select options={options} label="Status" placeholder="Any status" />);
      expect(screen.getByRole('combobox')).toHaveTextContent('Any status');
    });

    it('opens and selects with the keyboard alone', async () => {
      const onValueChange = vi.fn();
      const user = userEvent.setup();
      renderThemed(<Select options={options} label="Status" onValueChange={onValueChange} />);

      await user.tab();
      expect(screen.getByRole('combobox')).toHaveFocus();
      await user.keyboard('{Enter}');

      await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
      await user.keyboard('{ArrowDown}{Enter}');

      expect(onValueChange).toHaveBeenCalledTimes(1);
    });

    it('marks the chosen option as selected', async () => {
      const user = userEvent.setup();
      renderThemed(<Select options={options} label="Status" defaultValue="scheduled" />);
      await user.click(screen.getByRole('combobox'));

      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'Scheduled' })).toHaveAttribute(
          'aria-selected',
          'true',
        );
      });
    });

    it('does not open when disabled', async () => {
      const user = userEvent.setup();
      renderThemed(<Select options={options} label="Status" disabled />);
      await user.click(screen.getByRole('combobox'));
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  },
);
