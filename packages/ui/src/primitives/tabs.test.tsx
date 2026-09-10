import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { describeComponent, renderThemed } from '../testing/a11y.js';
import { Tabs } from './tabs.js';

const tabs = [
  { id: 'overview', label: 'Overview', content: <p>Overview panel</p> },
  { id: 'content', label: 'Content', content: <p>Content panel</p> },
  { id: 'settings', label: 'Settings', content: <p>Settings panel</p>, disabled: true },
];

describeComponent('Tabs', { render: () => <Tabs tabs={tabs} label="Campaign sections" /> }, () => {
  it('shows only the active panel', () => {
    renderThemed(<Tabs tabs={tabs} label="Campaign sections" />);
    expect(screen.getByText('Overview panel')).toBeVisible();
    expect(screen.queryByText('Content panel')).not.toBeInTheDocument();
  });

  it('uses a single tab stop, then arrow keys — the roving tabindex pattern', async () => {
    // A tablist that puts every tab in the tab order forces a keyboard user through all
    // of them to reach the panel. Radix implements the correct pattern.
    const user = userEvent.setup();
    renderThemed(<Tabs tabs={tabs} label="Campaign sections" />);

    await user.tab();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Content' })).toHaveFocus();
    expect(screen.getByText('Content panel')).toBeVisible();
  });

  it('skips a disabled tab', async () => {
    const user = userEvent.setup();
    renderThemed(<Tabs tabs={tabs} label="Campaign sections" />);
    await user.tab();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    // Settings is disabled, so it wraps back to Overview.
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
  });

  it('labels the tablist', () => {
    renderThemed(<Tabs tabs={tabs} label="Campaign sections" />);
    expect(screen.getByRole('tablist', { name: 'Campaign sections' })).toBeInTheDocument();
  });
});
