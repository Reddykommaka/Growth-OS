import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { describeComponent, renderThemed } from '../testing/a11y.js';
import { Button } from './button.js';
import { Menu } from './menu.js';

const items = [
  { id: 'edit', label: 'Edit' },
  { id: 'duplicate', label: 'Duplicate' },
  { id: 'archive', label: 'Archive', disabled: true },
  { id: 'delete', label: 'Delete', destructive: true },
];

const menu = (onSelect?: () => void) => (
  <Menu
    label="Campaign actions"
    trigger={<Button>Actions</Button>}
    items={items.map((i) => (i.id === 'edit' && onSelect !== undefined ? { ...i, onSelect } : i))}
  />
);

describeComponent('Menu', { render: () => menu() }, () => {
  it('opens with the keyboard and moves focus to the first item', async () => {
    const user = userEvent.setup();
    renderThemed(menu());

    await user.tab();
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus());
  });

  it('navigates with arrow keys and skips disabled items', async () => {
    const user = userEvent.setup();
    renderThemed(menu());

    // Opened from the keyboard, so focus starts on the first item. A pointer click
    // deliberately does NOT focus an item — that is correct pointer semantics, not a bug.
    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus());

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toHaveFocus();

    // Archive is disabled, so focus skips it and lands on Delete.
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
  });

  it('selects the focused item with Enter', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderThemed(menu(onSelect));

    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus());

    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderThemed(menu());
    const trigger = screen.getByRole('button', { name: 'Actions' });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    // Returning focus matters: without it the keyboard user is dropped at the document root.
    expect(trigger).toHaveFocus();
  });
});
