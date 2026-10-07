import { render } from '@testing-library/react-native';

import { CoverWash } from './cover-wash';

// Jest resolves `./cover-wash` to the native file; the web one is loaded by its name.
const { CoverWash: WebCoverWash } =
  jest.requireActual<typeof import('./cover-wash.web')>('./cover-wash.web');
type Styled = { props: { style: { backgroundImage: string } } };

const COLOR = { bg: '#102030', accent: '#f0a020', on_accent: '#000000' };

describe('CoverWash', () => {
  it('draws nothing for a book without cover colours', async () => {
    const native = await render(<CoverWash />);
    expect(native.toJSON()).toBeNull();
    const web = await render(<WebCoverWash color={{ bg: 'nope' }} />);
    expect(web.toJSON()).toBeNull();
  });

  it('draws the two radial layers in the cover colours on native', async () => {
    const { toJSON } = await render(<CoverWash color={COLOR} />);
    // react-native-svg hands its native view each gradient as [offset, ARGB, ...].
    const gradients: { cx: number; cy: number; rx: number; gradient: number[] }[] = [];
    const walk = (n: unknown) => {
      const node = n as { type?: string; props?: never; children?: unknown[] } | null;
      if (!node) return;
      if (node.type === 'RNSVGRadialGradient') gradients.push(node.props!);
      node.children?.forEach(walk);
    };
    walk(toJSON());
    const argb = (v: number) => [v >>> 24, (v >>> 0) & 0xffffff];
    // Light theme: the dominant from the top left at 30%, the vibrant from the bottom
    // right at 55% of that, each fading out by 70% of its radius.
    expect(gradients.map((g) => [g.cx, g.cy, g.rx])).toEqual([
      [0, 0, 0.7],
      [1, 1, 0.6],
    ]);
    expect(gradients.map((g) => [g.gradient[0], ...argb(g.gradient[1]), g.gradient[2]])).toEqual([
      [0, Math.round(0.3 * 255), 0x102030, 0.7],
      [0, Math.round(0.165 * 255), 0xf0a020, 0.7],
    ]);
    expect(argb(gradients[0].gradient[3])[0]).toBe(0);
  });

  it('paints CSS radial gradients on the web', async () => {
    const { toJSON } = await render(<WebCoverWash color={COLOR} variant="hero" />);
    const style = (toJSON() as unknown as Styled).props.style;
    expect(style.backgroundImage).toMatch(
      /^radial-gradient\(60% 100% at 15% 0%, rgba\(16, 32, 48, 0\.3\)/,
    );
  });
});
