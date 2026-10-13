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

  it('makes the words and the action bigger at the large size (kids mode)', async () => {
    await mount(
      <EmptyState
        variant="card"
        size="large"
        title="No stories here yet"
        hint="Ask a grown-up."
        action={{ label: 'Try again', onPress: () => {} }}
      />,
    );
    expect(screen.getByText('No stories here yet').props.className).toContain('text-2xl');
    expect(screen.getByText('Ask a grown-up.').props.className).toContain('text-base');
    // The big ink button, not the card's small outline one.
    expect(screen.getByRole('button', { name: 'Try again' }).props.className).toContain('h-[54px]');
  });
});
