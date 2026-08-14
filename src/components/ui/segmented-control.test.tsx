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

  it('stretches the pills when grow is set on a non-scrolling track', async () => {
    await mount(<SegmentedControl options={[...options]} value="all" onChange={jest.fn()} grow />);

    const pill = screen.getAllByRole('button')[0];
    expect(String(pill.props.className)).toContain('flex-1');
  });

  it('ignores grow inside a scroller (a flex-1 pill would collapse)', async () => {
    await mount(
      <SegmentedControl options={[...options]} value="all" onChange={jest.fn()} grow scrollable />,
    );

    const pill = screen.getAllByRole('button')[0];
    expect(String(pill.props.className)).not.toContain('flex-1');
  });

  it('switches to tablist/tab semantics in tab mode', async () => {
    await mount(
      <SegmentedControl
        options={[...options]}
        value="books"
        onChange={jest.fn()}
        scrollable
        role="tab"
      />,
    );

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1);
    // The pills are tabs, not buttons (the track itself carries `tablist`, which
    // RNTL's role query does not surface on a non-accessible container).
    expect(screen.queryByRole('button')).toBeNull();
  });
});
