import { render, screen } from '@testing-library/react-native';

import { Text } from '@/components/ui/text';
import { setFontScale } from '@/testing/font-scale';

import { SettingRow } from './settings-row';

const rowClass = () => String(screen.getByTestId('row').props.className);

describe('SettingRow under large text (fe#267)', () => {
  afterEach(async () => {
    await setFontScale(1);
  });

  it('puts a compact control beside its label at the default size', async () => {
    await render(
      <SettingRow label="Skip forward" testID="row">
        <Text>stepper</Text>
      </SettingRow>,
    );
    expect(rowClass()).toContain('flex-row');
  });

  it('puts every control under its label past the large-text threshold', async () => {
    await setFontScale(1.3);
    await render(
      <SettingRow label="Skip forward" testID="row">
        <Text>stepper</Text>
      </SettingRow>,
    );
    expect(rowClass()).not.toContain('flex-row');
    expect(String(screen.getByTestId('row-text').props.className)).not.toContain('flex-1');
  });
});
