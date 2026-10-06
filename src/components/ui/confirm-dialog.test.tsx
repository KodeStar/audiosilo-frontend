import { fireEvent, screen } from '@testing-library/react-native';

import { mountWithPortal } from '@/testing/render-overlay';

import { ConfirmDialog } from './confirm-dialog';

function props(over: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  return {
    visible: true,
    title: 'Remove Hearthside?',
    message: 'Its 3 downloaded books are deleted from this device.',
    confirmLabel: 'Remove',
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
    ...over,
  };
}

describe('ConfirmDialog', () => {
  it('shows the question as an alert dialog with a heading', async () => {
    await mountWithPortal(<ConfirmDialog {...props()} />);
    expect(screen.getByRole('heading', { name: 'Remove Hearthside?' })).toBeTruthy();
    expect(screen.getByText('Its 3 downloaded books are deleted from this device.')).toBeTruthy();
  });

  it('confirms and cancels through its own buttons', async () => {
    const p = props();
    await mountWithPortal(<ConfirmDialog {...p} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Remove' }));
    expect(p.onConfirm).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('makes a destructive confirm red', async () => {
    await mountWithPortal(
      <ConfirmDialog {...props({ destructive: true, confirmIcon: 'trash' })} />,
    );
    expect(String(screen.getByRole('button', { name: 'Remove' }).props.className)).toContain(
      'bg-destructive',
    );
  });

  it('renders nothing while hidden', async () => {
    await mountWithPortal(<ConfirmDialog {...props({ visible: false })} />);
    expect(screen.queryByText('Remove Hearthside?')).toBeNull();
  });
});
