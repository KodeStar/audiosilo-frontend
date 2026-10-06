import { fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';

import { Switch } from './switch';

function Harness() {
  const [on, setOn] = useState(false);
  return <Switch checked={on} onCheckedChange={setOn} accessibilityLabel="Smart speed" />;
}

describe('Switch', () => {
  it('is a labelled switch that toggles, pink only when on', async () => {
    await render(<Harness />);
    const sw = screen.getByRole('switch', { name: 'Smart speed' });
    expect(sw).not.toBeChecked();
    expect(String(sw.props.className)).toContain('bg-border-strong');

    await fireEvent.press(sw);
    const on = screen.getByRole('switch', { name: 'Smart speed' });
    expect(on).toBeChecked();
    expect(String(on.props.className)).toContain('bg-brand');
  });
});
