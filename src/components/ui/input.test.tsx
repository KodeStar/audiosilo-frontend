import { fireEvent, render, screen } from '@testing-library/react-native';

import { Input, Textarea } from './input';

function mount(ui: React.ReactElement) {
  return render(ui);
}

describe('Input', () => {
  it('is named by its label and reports typing', async () => {
    const onChangeText = jest.fn();
    await mount(<Input label="Server address" value="" onChangeText={onChangeText} />);

    expect(screen.getByText('Server address')).toBeTruthy();
    const field = screen.getByLabelText('Server address');
    await fireEvent.changeText(field, 'https://books.example.com');
    expect(onChangeText).toHaveBeenCalledWith('https://books.example.com');
  });

  it('draws the focus ring colour while focused', async () => {
    await mount(<Input accessibilityLabel="Search" />);
    const field = screen.getByLabelText('Search');
    expect(String(field.props.className)).toContain('border-input');
    await fireEvent(field, 'focus');
    expect(String(screen.getByLabelText('Search').props.className)).toContain('border-ring');
  });

  it('shows an error, marks the field invalid and announces it', async () => {
    await mount(<Input label="Password" error="Too short" />);
    expect(screen.getByLabelText('Password')).toHaveProp('aria-invalid', true);
    expect(String(screen.getByLabelText('Password').props.className)).toContain(
      'border-destructive',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Too short');
  });

  it('is 48 tall in the large size (server address, invite code)', async () => {
    await mount(<Input accessibilityLabel="Code" size="lg" />);
    expect(String(screen.getByLabelText('Code').props.className)).toContain('h-[48px]');
  });
});

describe('Textarea', () => {
  it('is a multi-line field', async () => {
    await mount(<Textarea accessibilityLabel="Note" />);
    expect(screen.getByLabelText('Note')).toHaveProp('multiline', true);
  });
});
