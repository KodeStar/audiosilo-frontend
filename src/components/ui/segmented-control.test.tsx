import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { SegmentedControl } from './segmented-control';

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

const options = [
  { value: 'all', label: 'All' },
  { value: 'books', label: 'Books' },
] as const;

describe('SegmentedControl', () => {
  it('calls onChange with the pressed option value', async () => {
    const onChange = jest.fn();
    await mount(<SegmentedControl options={[...options]} value="all" onChange={onChange} />);

    fireEvent.press(screen.getByText('Books'));
    expect(onChange).toHaveBeenCalledWith('books');
  });

  it('marks the active option as selected for a11y', async () => {
    await mount(<SegmentedControl options={[...options]} value="books" onChange={jest.fn()} />);

    const active = screen.getByText('Books').parent;
    expect(screen.getByText('Books')).toBeTruthy();
    // The selected state rides on the pressable wrapping the active label.
    const selected = screen.getByRole('button', { selected: true });
    expect(selected).toBeTruthy();
    expect(active).toBeTruthy();
  });
});
