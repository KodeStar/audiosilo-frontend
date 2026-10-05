import { fireEvent, render, screen } from '@testing-library/react-native';

import { Button } from './button';
import { Text } from './text';

function mount(ui: React.ReactElement) {
  return render(ui);
}

describe('Button', () => {
  it('is a button named by its title, and reports presses', async () => {
    const onPress = jest.fn();
    await mount(<Button title="Resume chapter 23" onPress={onPress} />);

    const button = screen.getByRole('button', { name: 'Resume chapter 23' });
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is ink by default (Stacks: primary buttons are never pink)', async () => {
    await mount(<Button title="Listen" />);
    const button = screen.getByRole('button');
    expect(String(button.props.className)).toContain('bg-primary');
    expect(String(button.props.className)).not.toContain('bg-brand');
    // The label takes the ink button's foreground through TextClassContext.
    expect(String(screen.getByText('Listen').props.className)).toContain('text-primary-foreground');
  });

  it('hands its label style to composed children', async () => {
    await mount(
      <Button variant="destructive-outline">
        <Text>Sign out</Text>
      </Button>,
    );
    expect(String(screen.getByText('Sign out').props.className)).toContain('text-destructive');
  });

  it('disables itself and reports busy while loading', async () => {
    const onPress = jest.fn();
    await mount(<Button title="Save" loading onPress={onPress} />);

    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    expect(button).toBeBusy();
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('grows the short sizes to a 44pt touch target', async () => {
    await mount(<Button title="Small" size="sm" />);
    // 30 tall + 7 above + 7 below.
    expect(screen.getByRole('button')).toHaveProp('hitSlop', 7);
  });

  it('takes an accessibility label when it is icon-only', async () => {
    await mount(<Button icon="trash" variant="secondary" accessibilityLabel="Delete download" />);
    expect(screen.getByRole('button', { name: 'Delete download' })).toBeTruthy();
  });
});
