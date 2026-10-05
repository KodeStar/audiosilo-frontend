import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { PressableRow, RowSurface } from './row-surface';

function mount(ui: React.ReactElement) {
  return render(ui);
}

describe('RowSurface / PressableRow', () => {
  it('draws the flat hairline surface and keeps the caller layout', async () => {
    await mount(<RowSurface testID="row" className="flex-row p-3" />);
    const cls = String(screen.getByTestId('row').props.className);
    expect(cls).toContain('border-border');
    expect(cls).toContain('bg-card');
    expect(cls).toContain('flex-row p-3');
    expect(cls).not.toContain('shadow');
  });

  it('is pressable, with a pressed state on the accent fill', async () => {
    const onPress = jest.fn();
    await mount(
      <PressableRow accessibilityRole="button" onPress={onPress}>
        <Text>Hearthside</Text>
      </PressableRow>,
    );
    const row = screen.getByRole('button', { name: 'Hearthside' });
    expect(String(row.props.className)).toContain('active:bg-accent');
    await fireEvent.press(row);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
