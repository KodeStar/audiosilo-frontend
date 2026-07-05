import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { SectionHeader } from './section-header';

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

describe('SectionHeader', () => {
  it('renders the title without an action', async () => {
    await mount(<SectionHeader title="Recently added" />);
    expect(screen.getByText('Recently added')).toBeTruthy();
  });

  it('renders and fires the optional action', async () => {
    const onPress = jest.fn();
    await mount(<SectionHeader title="Recently added" action={{ label: 'See all', onPress }} />);

    fireEvent.press(screen.getByText('See all'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
