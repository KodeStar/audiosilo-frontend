import { render, screen } from '@testing-library/react-native';

import { colors } from '@/theme/tokens';

import { Notice } from './notice';

jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

/** react-native-svg's processed colour: ARGB as one number (`#123456` -> 0xff123456). */
const argb = (hex: string) => parseInt(`ff${hex.slice(1)}`, 16);

/** The fill of every glyph path drawn. */
function fills(): number[] {
  type Node = { props?: Record<string, unknown>; children?: (Node | string)[] | null };
  const out: number[] = [];
  const walk = (n: Node | string | null) => {
    if (!n || typeof n === 'string') return;
    const fill = n.props?.fill as { payload?: number } | undefined;
    if (n.props?.d && typeof fill?.payload === 'number') out.push(fill.payload);
    (n.children ?? []).forEach(walk);
  };
  const root = screen.toJSON() as Node | Node[] | null;
  (Array.isArray(root) ? root : [root]).forEach(walk);
  return out;
}

describe('Notice', () => {
  it('says its headline and sentence, in the info tone by default', async () => {
    await render(<Notice icon="circle-info" title="Kept in this browser" body="One sentence." />);
    expect(screen.getByText('Kept in this browser')).toBeTruthy();
    expect(screen.getByText('One sentence.')).toBeTruthy();
    expect(fills()).toEqual([argb(colors.light.info)]);
  });

  it.each(['success', 'warning'] as const)('tints its glyph and tile for %s', async (tone) => {
    await render(<Notice icon="circle-check" tone={tone} title="T" body="B" testID="n" />);
    expect(fills()).toEqual([argb(colors.light[tone])]);
    const tile = screen.getByTestId('n').children[0] as unknown as { props: { className: string } };
    expect(tile.props.className).toContain(`bg-${tone}-soft`);
  });
});
