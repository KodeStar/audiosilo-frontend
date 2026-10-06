import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { SegmentedControl } from './toggle-group';

function mount(ui: React.ReactElement) {
  return render(ui);
}

const options = [
  { value: 'all', label: 'All' },
  { value: 'books', label: 'Books' },
] as const;

describe('SegmentedControl', () => {
  const prevOS = Platform.OS;
  afterEach(() => {
    Platform.OS = prevOS;
  });

  it('is a labelled radio group with exactly the chosen segment checked', async () => {
    await mount(
      <SegmentedControl
        options={[...options]}
        value="books"
        onChange={jest.fn()}
        accessibilityLabel="Kind"
      />,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Books', checked: true })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'All', checked: false })).toBeTruthy();
    expect(screen.getByLabelText('Kind')).toBeTruthy();
  });

  it('reports the pressed option, and keeps the chosen one on a second press', async () => {
    const onChange = jest.fn();
    await mount(<SegmentedControl options={[...options]} value="all" onChange={onChange} />);

    await fireEvent.press(screen.getByRole('radio', { name: 'Books' }));
    expect(onChange).toHaveBeenCalledWith('books');

    onChange.mockClear();
    await fireEvent.press(screen.getByRole('radio', { name: 'All' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows an optional count after the label, inside its accessible name', async () => {
    await mount(
      <SegmentedControl
        options={[
          { value: 'all', label: 'All' },
          { value: 'books', label: 'Books', count: 3249 },
        ]}
        value="all"
        onChange={jest.fn()}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Books, 3249' })).toBeTruthy();
    expect(screen.getByText('3,249')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'All' })).toBeTruthy();
  });

  it('raises the chosen segment on a card (Stacks), not a pink fill', async () => {
    await mount(<SegmentedControl options={[...options]} value="books" onChange={jest.fn()} />);
    const chosen = String(screen.getByRole('radio', { name: 'Books' }).props.className);
    expect(chosen).toContain('bg-card');
    expect(chosen).not.toContain('bg-brand');
  });

  it('stretches the segments when grow is set, but not inside a scroller', async () => {
    await mount(<SegmentedControl options={[...options]} value="all" onChange={jest.fn()} grow />);
    expect(String(screen.getAllByRole('radio')[0].props.className)).toContain('flex-1');
  });

  it('ignores grow when scrollable (a flex-1 segment would collapse)', async () => {
    await mount(
      <SegmentedControl options={[...options]} value="all" onChange={jest.fn()} grow scrollable />,
    );
    expect(String(screen.getAllByRole('radio')[0].props.className)).not.toContain('flex-1');
  });

  it('presses a segment like a tap (Space on web reaches the same press: rnw-button-fix)', async () => {
    const onChange = jest.fn();
    await mount(<SegmentedControl options={[...options]} value="all" onChange={onChange} />);
    await fireEvent.press(screen.getByRole('radio', { name: 'Books' }));
    expect(onChange).toHaveBeenCalledWith('books');
  });
});
