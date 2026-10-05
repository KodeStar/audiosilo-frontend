import { Text as RNText, type TextProps } from 'react-native';

import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

/**
 * The Stacks type scale (STYLEGUIDE.md section 4), one variant per role. Sizes are
 * Tailwind's rem steps (14px rem on native, 16px on web), the nearest to each role;
 * colours are themed tokens, so no variant needs a `dark:` pair.
 */
const variants = {
  /** Bricolage 750, set bold (static weights): book and series heroes. */
  'display-xl': 'font-display text-4xl tracking-tighter text-foreground',
  /** Bricolage 700: page greetings, onboarding titles. */
  display: 'font-display text-3xl tracking-tight text-foreground',
  /** Bricolage 680 (bold): section and page headings. */
  heading: 'font-display text-xl tracking-tight text-foreground',
  /** Bricolage 650 (semibold): card and sheet titles, book titles in lists. */
  title: 'font-display-semibold text-base text-foreground',
  /** Figtree 400: running text. */
  body: 'font-sans text-base text-foreground',
  /** Figtree 400, smaller and muted: secondary lines. */
  muted: 'font-sans text-sm text-muted-foreground',
  /** Figtree 650 (semibold): control labels, list-row titles. */
  label: 'font-sans-semibold text-sm text-foreground',
  /** Figtree 400, small and muted: meta lines ("22h 27m left at 1.25x"). */
  caption: 'font-sans text-xs text-muted-foreground',
  /** Figtree 650 caps: kickers above a title, field labels. */
  eyebrow: 'font-sans-semibold text-xs uppercase tracking-wider text-muted-foreground',
  /** JetBrains Mono 500: paths, codes. */
  mono: 'font-mono text-xs text-foreground',
  /** Bricolage 750 (bold), tabular: stat values ("11h 6m"). */
  stat: 'font-display text-2xl tracking-tight text-foreground',
} as const;

export type TextVariant = keyof typeof variants;

/** Roles whose figures must not jitter as digits change (the guide's tabular-nums). */
const TABULAR: ReadonlySet<TextVariant> = new Set(['stat', 'mono']);

export type AppTextProps = TextProps & { variant?: TextVariant; className?: string };

/**
 * Themed text on the Stacks type scale. A caller's class replaces the variant's class
 * for the same property and variant (`cn`), so `<Text variant="caption"
 * className="text-brand-ink">` recolours the caption in both themes (the colour is one
 * themed token, not a light/dark pair).
 */
export function Text({ variant = 'body', className, style, ...props }: AppTextProps) {
  return (
    <RNText
      className={cn(variants[variant], className)}
      style={TABULAR.has(variant) ? [tabularNums, style] : style}
      {...props}
    />
  );
}
