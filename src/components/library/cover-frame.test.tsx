import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

// theme-provider side-effect-imports global.css (unparseable in Node); stub the hook
// with a switchable scheme.
let mockScheme: 'light' | 'dark' = 'light';
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: mockScheme, pref: mockScheme, setPref: jest.fn() }),
}));

/* eslint-disable import/first */
import { CoverFrame } from './cover-frame';
/* eslint-enable import/first */

// jest-expo resolves the iOS platform files, so this exercises clipped-shadow.ios.ts:
// the inline legacy shadow a clipping frame needs on iOS (see src/global.css).
async function frame(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
  const root = screen.toJSON() as unknown as { props: { className: string; style?: object } };
  return { className: root.props.className.split(' '), style: root.props.style };
}

describe('CoverFrame', () => {
  it('xs: light-only soft shadow, inline on iOS in light mode only', async () => {
    mockScheme = 'light';
    const light = await frame(
      <CoverFrame>
        <Text>cover</Text>
      </CoverFrame>,
    );
    expect(light.className).toEqual(
      expect.arrayContaining([
        'overflow-hidden',
        'ios-clipped-shadow',
        'shadow-xs',
        'dark:shadow-none',
      ]),
    );
    expect(light.style).toMatchObject({ shadowRadius: 1, shadowOffset: { width: 0, height: 1 } });

    mockScheme = 'dark';
    const dark = await frame(
      <CoverFrame>
        <Text>cover</Text>
      </CoverFrame>,
    );
    expect(dark.style).toBeUndefined();
  });

  it('lg: the deeper shadow in both themes, plus the caller layout classes', async () => {
    mockScheme = 'dark';
    const lg = await frame(
      <CoverFrame size="lg" className="aspect-square w-40">
        <Text>cover</Text>
      </CoverFrame>,
    );
    expect(lg.className).toEqual(
      expect.arrayContaining([
        'overflow-hidden',
        'rounded-lg',
        'shadow-lg',
        'aspect-square',
        'w-40',
      ]),
    );
    expect(lg.className).not.toContain('dark:shadow-none');
    expect(lg.style).toMatchObject({ shadowRadius: 10, shadowOffset: { width: 0, height: 4 } });
  });
});
