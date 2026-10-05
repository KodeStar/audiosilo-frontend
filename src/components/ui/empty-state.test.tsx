import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { EmptyState } from './empty-state';

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
