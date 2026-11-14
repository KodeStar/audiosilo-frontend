import { render, screen } from '@testing-library/react-native';

import { DISPLAY_MAX_FONT_SCALE, headingLevelFor, Text, TextClassContext } from './text';

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

describe('display titles stop growing at 2x (fe#267)', () => {
  it('caps a display title, not running text, and lets a caller choose', async () => {
    await render(
      <>
        <Text variant="display">Settings</Text>
        <Text variant="display-xl">Hero</Text>
        <Text>Body</Text>
        <Text variant="display" maxFontSizeMultiplier={1.3}>
          Own
        </Text>
      </>,
    );
    expect(screen.getByText('Settings').props.maxFontSizeMultiplier).toBe(DISPLAY_MAX_FONT_SCALE);
    expect(screen.getByText('Hero').props.maxFontSizeMultiplier).toBe(DISPLAY_MAX_FONT_SCALE);
    expect(screen.getByText('Body').props.maxFontSizeMultiplier).toBeUndefined();
    expect(screen.getByText('Own').props.maxFontSizeMultiplier).toBe(1.3);
  });
});

describe('heading levels (fe#267: every heading was an h1 on the web)', () => {
  it("gives a header its type role's level", async () => {
    await mount(
      <>
        <Text variant="display" accessibilityRole="header">
          Good evening
        </Text>
        <Text variant="heading" accessibilityRole="header">
          Next in your series
        </Text>
        <Text variant="title" accessibilityRole="header">
          Chapters
        </Text>
      </>,
    );
    expect(screen.getByRole('header', { name: 'Good evening' })).toHaveProp('aria-level', 1);
    expect(screen.getByRole('header', { name: 'Next in your series' })).toHaveProp('aria-level', 2);
    expect(screen.getByRole('header', { name: 'Chapters' })).toHaveProp('aria-level', 3);
  });

  it('takes an explicit level, and makes a heading of a text given one', async () => {
    await mount(
      <Text variant="label" level={1}>
        Settings
      </Text>,
    );
    expect(screen.getByRole('header', { name: 'Settings' })).toHaveProp('aria-level', 1);
  });

  it('leaves a text without the role alone', async () => {
    await mount(<Text variant="heading">Plain</Text>);
    expect(screen.queryByRole('header')).toBeNull();
    expect(screen.getByText('Plain').props['aria-level']).toBeUndefined();
  });

  it('maps the roles to levels', () => {
    expect(headingLevelFor('display-xl')).toBe(1);
    expect(headingLevelFor('stat')).toBe(2);
    expect(headingLevelFor('caption')).toBe(3);
  });
});
