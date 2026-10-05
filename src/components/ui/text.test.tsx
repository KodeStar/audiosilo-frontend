import { render, screen } from '@testing-library/react-native';

import { Text, TextClassContext } from './text';

function mount(ui: React.ReactElement) {
  return render(ui);
}

describe('Text', () => {
  it('renders a type role, and a caller class replaces the role colour', async () => {
    await mount(
      <Text variant="caption" className="text-brand-ink">
        Just met
      </Text>,
    );
    const cls = String(screen.getByText('Just met').props.className);
    expect(cls).toContain('text-xs');
    expect(cls).toContain('text-brand-ink');
    expect(cls).not.toContain('text-muted-foreground');
  });

  it('takes the classes a control provides through TextClassContext', async () => {
    await mount(
      <TextClassContext.Provider value="font-sans-semibold text-sm text-primary-foreground">
        <Text>Resume</Text>
      </TextClassContext.Provider>,
    );
    const cls = String(screen.getByText('Resume').props.className);
    expect(cls).toContain('text-primary-foreground');
    expect(cls).toContain('font-sans-semibold');
    expect(cls).not.toContain('text-foreground ');
  });

  it("lets the caller's class win over the context", async () => {
    await mount(
      <TextClassContext.Provider value="text-primary-foreground">
        <Text className="text-destructive">Remove</Text>
      </TextClassContext.Provider>,
    );
    const cls = String(screen.getByText('Remove').props.className);
    expect(cls).toContain('text-destructive');
    expect(cls).not.toContain('text-primary-foreground');
  });
});
