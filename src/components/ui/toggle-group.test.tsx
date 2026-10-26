import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';

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

  // Native-only layout jest can't measure (HORIZONTAL_SCROLLER says why): the phone
  // Library's sections ate the screen and its grid got 0 height.
  it('keeps a scrolling control to its own height (no native flex-grow)', async () => {
    await mount(
      <SegmentedControl options={[...options]} value="all" onChange={jest.fn()} scrollable />,
    );
    const scroller = screen.getByTestId('segment-scroller');
    expect(StyleSheet.flatten(scroller.props.style)?.flexGrow).toBe(0);
  });

  // PLAYER-14: the You hub's six sections at 390 (a 350 viewport over 451 of tabs) must
  // say there are more past the edge.
  it('fades the side that has more, while the segments overflow the scroller', async () => {
    const six = ['Stats', 'Year', 'Journal', 'Settings', 'Household', 'Account'].map((l) => ({
      value: l.toLowerCase(),
      label: l,
    }));
    await mount(<SegmentedControl options={six} value="stats" onChange={jest.fn()} scrollable />);
    const scroller = screen.getByTestId('segment-scroller');
    const fade = (side: string) =>
      screen.queryByTestId(`segment-fade-${side}`, { includeHiddenElements: true });
    await fireEvent(scroller, 'layout', { nativeEvent: { layout: { width: 350, height: 36 } } });
    await fireEvent(scroller, 'contentSizeChange', 451, 36);
    expect(fade('right')).toBeTruthy();
    expect(fade('left')).toBeNull();
    // Scrolled to the end: the start has more now, the end none.
    await fireEvent.scroll(scroller, { nativeEvent: { contentOffset: { x: 101, y: 0 } } });
    expect(fade('left')).toBeTruthy();
    expect(fade('right')).toBeNull();
    // Room for every segment: no fade at all.
    await fireEvent(scroller, 'layout', { nativeEvent: { layout: { width: 460, height: 36 } } });
    await fireEvent.scroll(scroller, { nativeEvent: { contentOffset: { x: 0, y: 0 } } });
    expect(fade('left')).toBeNull();
    expect(fade('right')).toBeNull();
  });
});
