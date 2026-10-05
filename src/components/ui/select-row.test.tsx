import { act, fireEvent, render, screen } from '@testing-library/react-native';

// Zero insets so the sheet doesn't depend on a SafeAreaProvider in the test tree.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

/* eslint-disable import/first */
import { SelectRow, SelectSheet } from './select-row';
/* eslint-enable import/first */

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

const options = [
  { value: 'chapter', label: 'End of chapter' },
  { value: '30', label: '30 min' },
] as const;

describe('SelectRow', () => {
  it('shows the label and the current value, and reports the tap', async () => {
    const onPress = jest.fn();
    await mount(<SelectRow label="Timer" value="End of chapter" onPress={onPress} />);

    expect(screen.getByText('Timer')).toBeTruthy();
    await fireEvent.press(screen.getByText('End of chapter'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('SelectSheet', () => {
  it('reports the picked option and closes', async () => {
    const onChange = jest.fn();
    const onClose = jest.fn();
    await mount(
      <SelectSheet
        visible
        title="Timer"
        options={[...options]}
        value="chapter"
        onChange={onChange}
        onClose={onClose}
      />,
    );

    await fireEvent.press(screen.getByText('30 min'));
    expect(onChange).toHaveBeenCalledWith('30');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('marks exactly the current option as selected for a11y', async () => {
    await mount(
      <SelectSheet
        visible
        title="Timer"
        options={[...options]}
        value="30"
        onChange={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    const selected = screen.getAllByRole('button', { selected: true });
    expect(selected).toHaveLength(1);
    expect(screen.getByLabelText('30 min')).toBeTruthy();
  });

  it('renders nothing when closed', async () => {
    await mount(
      <SelectSheet
        visible={false}
        title="Timer"
        options={[...options]}
        value="chapter"
        onChange={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(screen.queryByText('30 min')).toBeNull();
  });
});
