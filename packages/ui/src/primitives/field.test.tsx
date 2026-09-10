import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { describeComponent, renderThemed } from '../testing/a11y.js';
import { Field, Input } from './field.js';

const basic = (props: { hint?: string; error?: string } = {}) => (
  <Field label="Workspace name" {...props}>
    {({ inputId, describedBy, invalid }) => (
      <Input
        id={inputId}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        defaultValue=""
      />
    )}
  </Field>
);

describeComponent(
  'Field',
  {
    render: () => basic(),
    states: {
      'with-hint': () => basic({ hint: 'Shown to your team only.' }),
      'with-error': () => basic({ error: 'Name is already taken.' }),
      disabled: () => (
        <Field label="Locked">{({ inputId }) => <Input id={inputId} disabled />}</Field>
      ),
    },
  },
  () => {
    it('associates the label with the control', async () => {
      const user = userEvent.setup();
      renderThemed(basic());
      // getByLabelText only resolves when the association is real.
      const input = screen.getByLabelText('Workspace name');
      await user.click(input);
      expect(input).toHaveFocus();
    });

    it('references the hint via aria-describedby', () => {
      renderThemed(basic({ hint: 'Shown to your team only.' }));
      const input = screen.getByLabelText('Workspace name');
      const describedBy = input.getAttribute('aria-describedby');
      expect(describedBy).not.toBeNull();
      expect(document.getElementById(describedBy ?? '')).toHaveTextContent(
        'Shown to your team only.',
      );
    });

    it('announces an error and marks the control invalid', () => {
      // Error text that is visually adjacent but not referenced is invisible to a screen
      // reader — the most common accessibility defect in form UI.
      renderThemed(basic({ error: 'Name is already taken.' }));
      const input = screen.getByLabelText('Workspace name');
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('alert')).toHaveTextContent('Name is already taken.');
      expect(input.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
    });

    it('references both hint and error when both are present', () => {
      renderThemed(basic({ hint: 'A hint.', error: 'An error.' }));
      const describedBy =
        screen.getByLabelText('Workspace name').getAttribute('aria-describedby') ?? '';
      expect(describedBy.split(' ')).toHaveLength(2);
    });

    it('generates unique ids across instances', () => {
      renderThemed(
        <>
          {basic()}
          {basic()}
        </>,
      );
      const [first, second] = screen.getAllByLabelText('Workspace name');
      expect(first?.id).not.toBe(second?.id);
    });
  },
);
