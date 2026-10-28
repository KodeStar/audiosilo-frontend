import { memo } from 'react';
import { render } from '@testing-library/react-native';

// Guards patches/react-native-web+*.patch: react-native-web wraps every host element
// with a `dir` (each root Text has dir="auto") in its LocaleProvider, which built a new
// context value on every render, so a re-rendering parent re-rendered every View and
// Text below it straight through memo. The patch memoises the value on direction and
// locale. Both builds are patched and checked: the web export bundles the CJS one today,
// and a resolver change could pick the ESM one.
/* eslint-disable @typescript-eslint/no-require-imports */
const builds = {
  esm: require('react-native-web/dist/modules/useLocale'),
  cjs: require('react-native-web/dist/cjs/modules/useLocale'),
};
/* eslint-enable @typescript-eslint/no-require-imports */

type LocaleValue = { direction: string; locale?: string };

describe.each(Object.entries(builds))('react-native-web LocaleProvider (%s)', (_name, mod) => {
  const seen: LocaleValue[] = [];
  const Consumer = memo(function Consumer() {
    seen.push(mod.useLocaleContext());
    return null;
  });
  const tree = (direction: string, locale?: string, tick = 0) => (
    <mod.LocaleProvider direction={direction} locale={locale} tick={tick}>
      <Consumer />
    </mod.LocaleProvider>
  );

  beforeEach(() => {
    seen.length = 0;
  });

  it('keeps the context value when it re-renders with the same direction and locale', async () => {
    const view = await render(tree('auto', undefined, 0));
    await view.rerender(tree('auto', undefined, 1));
    await view.rerender(tree('auto', undefined, 2));
    // The memoised consumer rendered once: the value never changed identity.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ direction: 'auto', locale: undefined });
  });

  it('still hands consumers a new value when the direction or locale changes', async () => {
    const view = await render(tree('ltr'));
    await view.rerender(tree('rtl'));
    await view.rerender(tree('ltr', 'ar'));
    await view.rerender(tree('ltr', 'en-GB'));
    expect(seen).toEqual([
      { direction: 'ltr', locale: undefined },
      { direction: 'rtl', locale: undefined },
      // A locale decides the direction, as before the patch.
      { direction: 'rtl', locale: 'ar' },
      { direction: 'ltr', locale: 'en-GB' },
    ]);
  });
});
