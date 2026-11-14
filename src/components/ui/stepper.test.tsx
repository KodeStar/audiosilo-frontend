import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { expectNativeTarget } from '@/testing/touch-target';
import { colors } from '@/theme/tokens';

import { Stepper } from './stepper';

/** A `#rrggbb` token as react-native-svg's processed opaque ARGB number. */
const argb = (hex: string) => 0xff000000 + parseInt(hex.slice(1), 16);

/** The fills of every drawn glyph path in a rendered tree. */
function glyphFills(node: unknown): number[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(glyphFills);
  const n = node as { type?: string; props?: { fill?: { payload?: number } }; children?: unknown };
  const own = n.type === 'RNSVGPath' && n.props?.fill?.payload ? [n.props.fill.payload] : [];
  return [...own, ...glyphFills(n.children)];
}

const props = {
  value: 15,
  step: 5,
  min: 5,
  max: 120,
  format: (v: number) => `${v}s`,
  label: 'Skip back',
};

describe('Stepper', () => {
  it('names its buttons after the setting and clamps at its bounds', async () => {
    const onChange = jest.fn();
    await render(<Stepper {...props} onChange={onChange} />);
    await fireEvent.press(screen.getByLabelText('Skip back, more'));
    expect(onChange).toHaveBeenCalledWith(20);
    await fireEvent.press(screen.getByLabelText('Skip back, less'));
    expect(onChange).toHaveBeenCalledWith(10);

    await render(<Stepper {...props} value={5} onChange={onChange} />);
    expect(screen.getByLabelText('Skip back, less')).toBeDisabled();
  });

  // fe#267: a fixed w-16 wrapped "15s" to "15 / s" at iOS's AX5.
  it('keeps its value on one line in a box that grows with it', async () => {
    await render(<Stepper {...props} onChange={jest.fn()} />);
    const value = screen.getByTestId('stepper-value');
    expect(value.props.numberOfLines).toBe(1);
    expect(String(value.props.className)).toContain('min-w-16');
    expect(String(value.props.className)).not.toMatch(/(^|\s)w-16/);
  });

  it('gives each button a 44 pt frame on native and a slop on the web', async () => {
    const prev = Platform.OS;
    try {
      Platform.OS = 'ios';
      await render(<Stepper {...props} onChange={jest.fn()} />);
      expectNativeTarget(screen.getByLabelText('Skip back, more'));
      Platform.OS = 'web';
      await render(<Stepper {...props} onChange={jest.fn()} />);
      expect(screen.getByLabelText('Skip back, more').props.hitSlop).toEqual({
        top: 4,
        bottom: 4,
        left: 4,
        right: 4,
      });
    } finally {
      Platform.OS = prev;
    }
  });

  it('draws its glyphs in ink, never pink (one pink thing per view)', async () => {
    // The device pass: a Settings pane has a stepper on every row, each pair pink.
    await render(<Stepper {...props} onChange={jest.fn()} />);
    const fills = glyphFills(screen.toJSON());
    expect(fills.length).toBeGreaterThan(0);
    expect(new Set(fills)).toEqual(new Set([argb(colors.light.foreground)]));
  });
});
