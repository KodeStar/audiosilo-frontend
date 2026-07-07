import { act, fireEvent, render, screen } from '@testing-library/react-native';

// Mock the theme hook so the primitive doesn't need a ThemeProvider (whose module
// also side-effect-imports global.css, unparseable in the Node test runtime).
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: 'dark', pref: 'dark', setPref: jest.fn() }),
}));

/* eslint-disable import/first */
import { EmptyState } from './empty-state';
/* eslint-enable import/first */

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

describe('EmptyState', () => {
  it('renders title and hint', async () => {
    await mount(<EmptyState title="No downloads yet" hint="Books you save appear here." />);
    expect(screen.getByText('No downloads yet')).toBeTruthy();
    expect(screen.getByText('Books you save appear here.')).toBeTruthy();
  });

  it('renders and fires the optional action', async () => {
    const onPress = jest.fn();
    await mount(<EmptyState title="Nothing here" action={{ label: 'Browse library', onPress }} />);

    fireEvent.press(screen.getByText('Browse library'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
