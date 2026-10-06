import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge the theme names it can't know: the Stacks radii and overlay
// shadow (src/global.css), so `cn('rounded-control', 'rounded-full')` resolves to one.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ['cover', 'control', 'menu', 'card', 'dialog', 'sheet'],
      shadow: ['overlay'],
    },
  },
});

/**
 * Builds a className from conditional parts (`clsx`) and resolves Tailwind conflicts so
 * the LAST conflicting class wins (`tailwind-merge`): `cn('px-4 py-12', 'py-6')` is
 * `'px-4 py-6'`. Uniwind applies every class it is given (no de-duplication), and which
 * of two conflicting classes wins then differs by platform - stylesheet order on web,
 * className order on native - so a component that lets a caller override its own
 * classes merges them with `cn`. The shadcn / react-native-reusables convention
 * (`@/lib/utils`).
 *
 * Only classes with the SAME variants conflict: `cn('text-foreground dark:text-white',
 * 'text-brand-ink')` keeps `dark:text-white`, and a variant class (`dark:`, `active:`,
 * `ios:`, `md:`...) outranks a plain one on every platform - so that text is still
 * white in dark mode. Override the variant class too to change it. (The themed colour
 * tokens need no `dark:` half, so this mostly bites a hand-written `dark:` class.)
 *
 * Caveat: tailwind-merge treats a later shorthand as replacing an earlier longhand
 * (`cn('px-4', 'p-3')` drops `px-4`), whereas CSS and React Native keep the longhand -
 * only reach for `cn` where "last one wins" is the intended rule.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
