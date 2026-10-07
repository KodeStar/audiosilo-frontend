import { act, fireEvent, screen } from '@testing-library/react-native';

import { useSettings } from '@/stores/settings';
import { mountWithPortal } from '@/testing/render-overlay';

import { usePlayerSheets } from './player-sheets';
import { ShortcutsDialog } from './shortcuts-dialog';

beforeEach(() => {
  usePlayerSheets.setState({ open: null });
  useSettings.setState({ skipForward: 30, skipBackward: 15 });
});

describe('ShortcutsDialog', () => {
  it('opens on request and lists the shortcuts with their keys', async () => {
    await mountWithPortal(<ShortcutsDialog />);
    expect(screen.queryByText('Keyboard shortcuts')).toBeNull();
    await act(async () => usePlayerSheets.getState().openSheet('shortcuts'));
    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeTruthy();
    expect(screen.getByLabelText('Play or pause: Space or K')).toBeTruthy();
    expect(screen.getByLabelText('Back 15 seconds: J or ←')).toBeTruthy();
    expect(screen.getByLabelText('Forward 30 seconds: L or →')).toBeTruthy();
    expect(screen.getByLabelText('Up next: Q')).toBeTruthy();
    expect(screen.getByLabelText('This help: ?')).toBeTruthy();
  });

  it('closes through the store', async () => {
    usePlayerSheets.setState({ open: 'shortcuts' });
    await mountWithPortal(<ShortcutsDialog />);
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(usePlayerSheets.getState().open).toBeNull();
  });

  it('stays closed for the other sheets', async () => {
    usePlayerSheets.setState({ open: 'sleep' });
    await mountWithPortal(<ShortcutsDialog />);
    expect(screen.queryByText('Keyboard shortcuts')).toBeNull();
  });
});
