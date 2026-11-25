import { render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';

import { setFontScale } from '@/testing/font-scale';

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
  afterEach(() => setFontScale(1));

  it('caps a display title, not running text, and lets a caller choose', async () => {
    await setFontScale(3.1);
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

  it('shares the web cap across title sizes and preserves caller overrides (fe#305)', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      await render(
        <>
          <Text variant="display">Settings</Text>
          <Text variant="display-xl">Hero</Text>
          <Text variant="display" className="text-xl md:text-lg">
            Small
          </Text>
          <Text variant="display" className="text-display-38 leading-display-42">
            Greeting
          </Text>
          <Text>Body</Text>
        </>,
      );
      const props = (text: string) => screen.getByText(text).props;
      const cap = StyleSheet.flatten(props('Settings').style);
      expect(cap['--display-px']).toBe(`min(0.0625rem, ${DISPLAY_MAX_FONT_SCALE}px)`);
      expect(props('Settings').className).toMatch(/display-title .*text-3xl/);
      expect(props('Hero').className).toMatch(/display-title .*text-4xl/);
      expect(props('Small').className).toMatch(/display-title .*text-xl md:text-lg/);
      expect(props('Small').className).not.toMatch(/text-3xl|web:text-/);
      expect(props('Greeting').className).toContain('text-display-38 leading-display-42');
      expect(props('Greeting').className).not.toMatch(/text-3xl|web:text-/);
      expect(props('Body').className).not.toContain('display-title');
      expect(StyleSheet.flatten(props('Body').style)?.['--display-px']).toBeUndefined();
    } finally {
      os.restore();
    }
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
