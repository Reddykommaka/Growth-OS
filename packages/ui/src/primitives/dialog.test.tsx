import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { describeComponent, renderThemed } from '../testing/a11y.js';
import { Button } from './button.js';
import { Dialog, DialogClose } from './dialog.js';

const openDialog = (props: Partial<{ description: string }> = {}) => (
  <Dialog
    open
    title="Delete campaign"
    footer={
      <DialogClose asChild>
        <Button>Cancel</Button>
      </DialogClose>
    }
    {...props}
  >
    <p>This cannot be undone.</p>
  </Dialog>
);

describeComponent(
  'Dialog',
  {
    render: () => openDialog({ description: 'This removes the campaign permanently.' }),
    states: {
      'no-description': () => openDialog(),
    },
  },
  () => {
    it('exposes an accessible name from its title', () => {
      renderThemed(openDialog());
      expect(screen.getByRole('dialog', { name: 'Delete campaign' })).toBeInTheDocument();
    });

    it('always has a description target, even when none is supplied', () => {
      // Radix warns and leaves the dialog undescribed otherwise.
      renderThemed(openDialog());
      expect(screen.getByRole('dialog')).toHaveAttribute('aria-describedby');
    });

    it('moves focus into the dialog when opened', async () => {
      renderThemed(openDialog());
      await waitFor(() => {
        expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
      });
    });

    it('traps focus — tabbing never escapes to the page behind', async () => {
      // The failure this prevents: a keyboard user tabs out of an open modal and is
      // stranded behind an overlay they cannot see or dismiss (ADR-0010).
      const user = userEvent.setup();
      renderThemed(openDialog());
      const dialog = screen.getByRole('dialog');

      for (let i = 0; i < 8; i++) {
        await user.tab();
        expect(dialog.contains(document.activeElement)).toBe(true);
      }
    });

    it('closes on Escape', async () => {
      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      renderThemed(
        <Dialog open onOpenChange={onOpenChange} title="Delete campaign">
          <p>Body</p>
        </Dialog>,
      );
      await user.keyboard('{Escape}');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('closes via a DialogClose trigger', async () => {
      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      renderThemed(
        <Dialog
          open
          onOpenChange={onOpenChange}
          title="Delete campaign"
          footer={
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
          }
        >
          <p>Body</p>
        </Dialog>,
      );
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  },
);
