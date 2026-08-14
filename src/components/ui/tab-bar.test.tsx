import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { TabBar } from './tab-bar';

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

const options = [
  { value: 'chapters', label: 'Chapters' },
  { value: 'notes', label: 'Notes' },
  { value: 'series', label: 'Series' },
] as const;

// The behaviour lives in SegmentedControl (see its test); this only pins the
// wrapper's wiring: every tab rendered, tab semantics on, presses reported.
describe('TabBar', () => {
  it('renders each option as a tab and reports presses', async () => {
    const onChange = jest.fn();
    await mount(<TabBar options={[...options]} value="notes" onChange={onChange} />);

    expect(screen.getByText('Chapters')).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1);

    fireEvent.press(screen.getByText('Series'));
    expect(onChange).toHaveBeenCalledWith('series');
  });
});
