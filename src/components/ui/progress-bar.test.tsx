import { render, screen } from '@testing-library/react-native';

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
    expect(track).not.toContain('bg-muted');
  });

  it('lets the caller recolour the fill (a second bar where the pink is elsewhere)', async () => {
    expect((await bar(<ProgressBar fraction={0.5} />)).fillClass).toContain('bg-brand');
    const { fillClass } = await bar(
      <ProgressBar fraction={0.5} fillClassName="bg-foreground/60" />,
    );
    expect(fillClass).toContain('bg-foreground/60');
    expect(fillClass).not.toContain('bg-brand');
  });
});
