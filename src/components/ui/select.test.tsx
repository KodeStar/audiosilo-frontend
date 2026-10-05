import { fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { Platform } from 'react-native';

import { mountWithPortal } from '@/testing/render-overlay';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

const OPTIONS = [
  { value: 'chapter', label: 'End of chapter' },
  { value: '30', label: '30 min' },
];

function Harness({ onChange }: { onChange: (v: string) => void }) {
  const [value, setValue] = useState(OPTIONS[0]);
  return (
    <Select
      value={value}
      onValueChange={(o) => {
        if (!o) return;
        setValue(o);
        onChange(o.value);
      }}
    >
      <SelectTrigger accessibilityLabel="Timer">
        <SelectValue placeholder="Pick one" />
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value} label={o.label} />
        ))}
      </SelectContent>
    </Select>
  );
}

describe('Select', () => {
  const prevOS = Platform.OS;
  afterEach(() => {
    Platform.OS = prevOS;
  });

  it('shows the chosen label on a closed trigger', async () => {
    await mountWithPortal(<Harness onChange={jest.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Timer' })).toBeTruthy();
    expect(screen.getByText('End of chapter')).toBeTruthy();
    expect(screen.queryByText('30 min')).toBeNull();
  });

  it('opens on press and reports the picked option', async () => {
    const onChange = jest.fn();
    await mountWithPortal(<Harness onChange={onChange} />);

    await fireEvent.press(screen.getByRole('combobox', { name: 'Timer' }));
    await fireEvent.press(screen.getByText('30 min'));
    expect(onChange).toHaveBeenCalledWith('30');
    expect(screen.getByText('30 min')).toBeTruthy();
  });

  it('opens with Space on web (react-native-web swallows it before Radix)', async () => {
    await mountWithPortal(<Harness onChange={jest.fn()} />);
    Platform.OS = 'web';
    await fireEvent(screen.getByRole('combobox', { name: 'Timer' }), 'keyDown', { key: ' ' });
    // Open (on web Radix then renders the list; the native test renderer only flips state).
    expect(screen.getByRole('combobox', { name: 'Timer' })).toBeExpanded();
  });

  it('ignores Space off the web (native has no keyboard path to fix)', async () => {
    await mountWithPortal(<Harness onChange={jest.fn()} />);
    await fireEvent(screen.getByRole('combobox', { name: 'Timer' }), 'keyDown', { key: ' ' });
    expect(screen.getByRole('combobox', { name: 'Timer' })).not.toBeExpanded();
  });
});
