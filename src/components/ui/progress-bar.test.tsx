import { render, screen } from '@testing-library/react-native';

import { ScopedThemeColors, ThemeColorsProvider } from '@/theme/use-theme-colors';

import { ProgressBar } from './progress-bar';

type Node = { props: { className?: string; style?: { width?: string } }; children: Node[] };

async function bar(
  el: React.ReactElement,
): Promise<{ track: string; fill: string; fillClass: string }> {
  await render(el);
  const root = screen.toJSON() as unknown as Node;
  const fill = root.children[0].props;
  return {
    track: String(root.props.className),
    fill: String(fill.style?.width),
    fillClass: String(fill.className),
  };
}

const highContrast = (el: React.ReactElement) => (
  <ThemeColorsProvider highContrast>
    <ScopedThemeColors theme="light">{el}</ScopedThemeColors>
  </ThemeColorsProvider>
);

describe('ProgressBar', () => {
  it('fills to the fraction, clamped, and never under the minimum', async () => {
    expect((await bar(<ProgressBar fraction={0.4} />)).fill).toBe('40%');
    expect((await bar(<ProgressBar fraction={1.5} />)).fill).toBe('100%');
    expect((await bar(<ProgressBar fraction={0.01} minPercent={4} />)).fill).toBe('4%');
  });

  it('lets the caller restyle the track', async () => {
    const { track } = await bar(<ProgressBar fraction={0.5} className="h-1.5 bg-white/35" />);
    expect(track).toContain('h-1.5');
    expect(track).toContain('bg-white/35');
    expect(track).not.toContain('bg-track');
  });

  it('lets the caller recolour the fill (a second bar where the pink is elsewhere)', async () => {
    expect((await bar(<ProgressBar fraction={0.5} />)).fillClass).toContain('bg-brand');
    const { fillClass } = await bar(
      <ProgressBar fraction={0.5} fillClassName="bg-foreground/60" />,
    );
    expect(fillClass).toContain('bg-foreground/60');
    expect(fillClass).not.toContain('bg-brand');
  });

  it('outlines the track only in high contrast', async () => {
    await render(<ProgressBar fraction={0.5} />);
    expect(screen.queryByTestId('track-outline')).toBeNull();
    await render(highContrast(<ProgressBar fraction={0.5} fillTestID="fill" />));
    const outline = screen.getByTestId('track-outline');
    expect(String(outline.props.className)).toContain('border-input');
    // Under the fill (an earlier sibling), so its edges never cover the value.
    const siblings = (outline.parent?.children ?? []) as unknown as Node[];
    expect(siblings.map((s) => (s.props as { testID?: string }).testID)).toEqual([
      'track-outline',
      'fill',
    ]);
  });

  it('leaves a hairline without the outline', async () => {
    await render(highContrast(<ProgressBar fraction={0.5} className="h-[2px]" outline={false} />));
    expect(screen.queryByTestId('track-outline')).toBeNull();
  });
});
