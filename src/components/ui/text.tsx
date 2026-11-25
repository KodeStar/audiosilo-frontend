import { createContext, type Ref, useContext } from 'react';
import {
  Platform,
  Text as RNText,
  type TextInstance,
  type TextProps,
  type TextStyle,
} from 'react-native';

import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

/**
 * The Stacks type scale (STYLEGUIDE.md section 4), one variant per role. Sizes are
 * Tailwind's rem steps (14px rem on native, 16px on web), the nearest to each role;
 * colours are themed tokens, so no variant needs a `dark:` pair.
 */
/** The eyebrow role's classes, for primitives that render their own text node (a field
 * label, a menu label) and so can't use `<Text variant="eyebrow">`. */
export const EYEBROW_CLASS =
  'font-sans-semibold text-xs uppercase tracking-wider text-muted-foreground';

/** The title line of a mini card (the mini player, the accessory player, the episode fetch
 * strip), over a `label` variant. */
export const MINI_TITLE_CLASS =
  'text-[13.5px] web:text-[0.84375rem] leading-[17px] web:leading-[1.0625rem]';

/** The web's keyboard focus ring on a pressable (put it in its `web` classes): the
 * browser outline off, the ring token on `:focus-visible`. */
export const FOCUS_RING_CLASS = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';
/** The focus ring set off from the control by a page-coloured gap: for a filled or
 * bordered control (a button, a chip, a card) whose own edge would hide a flush ring. */
export const FOCUS_RING_OFFSET_CLASS = `${FOCUS_RING_CLASS} focus-visible:ring-offset-2 focus-visible:ring-offset-background`;

const variants = {
  /** Bricolage 750, set bold (static weights): book and series heroes. The web's size stops
   * at 2x (`DISPLAY_MAX_FONT_SCALE`), which the browser has no `maxFontSizeMultiplier` for. */
  'display-xl': 'display-title font-display text-4xl tracking-tighter text-foreground',
  /** Bricolage 700: page greetings, onboarding titles. Capped at 2x on the web too. */
  display: 'display-title font-display text-3xl tracking-tight text-foreground',
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
  eyebrow: EYEBROW_CLASS,
  /** JetBrains Mono 500: paths, codes. */
  mono: 'font-mono text-xs text-foreground',
  /** Bricolage 750 (bold), tabular: stat values ("11h 6m"). */
  stat: 'font-display text-2xl tracking-tight text-foreground',
} as const;

export type TextVariant = keyof typeof variants;

/** Roles whose figures must not jitter as digits change (the guide's tabular-nums). */
const TABULAR: ReadonlySet<TextVariant> = new Set(['stat', 'mono']);

/**
 * Classes a control hands to the `<Text>` inside it (react-native-reusables'
 * convention): a Button sets its label colour and weight here, so
 * `<Button><Text>Resume</Text></Button>` needs no classes of its own. Merged after the
 * variant and before the caller's `className`, so an explicit class still wins.
 *
 * Only controls set it - never a container (Card, Dialog, Popover): a container's
 * colour would override every `muted`/`caption` variant inside it.
 */
export const TextClassContext = createContext<string | undefined>(undefined);

/** A heading's level (`aria-level`; the web renders `h1`..`h6`). */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type AppTextProps = TextProps & {
  variant?: TextVariant;
  className?: string;
  /** A heading at this level: the `header` role on iOS and Android, `hN` on the web. A
   * text given the `header` role without one takes its variant's level
   * (`headingLevelFor`). */
  level?: HeadingLevel;
  /** The native text (React 19 passes `ref` as a prop): a screen reader's focus target. */
  ref?: Ref<TextInstance>;
};

/**
 * The level a heading takes from its type role when its caller names none (fe#267: every
 * heading was an `h1` on the web): a page title (`display-xl`, `display`) 1, a section
 * (`heading`, `stat`) 2, anything smaller (a card or sheet title) 3.
 */
export function headingLevelFor(variant: TextVariant): HeadingLevel {
  if (isDisplay(variant)) return 1;
  if (variant === 'heading' || variant === 'stat') return 2;
  return 3;
}

/** Display titles follow the system size up to this multiplier. */
export const DISPLAY_MAX_FONT_SCALE = 2;

// One design pixel follows the browser font up to the native cap. The display
// utilities in global.css multiply by it, including a caller's named size.
const WEB_DISPLAY_STYLE = {
  '--display-px': `min(0.0625rem, ${DISPLAY_MAX_FONT_SCALE}px)`,
} as TextStyle;

/** A page title's type role (`display-xl`, `display`). */
function isDisplay(variant: TextVariant): boolean {
  return variant === 'display-xl' || variant === 'display';
}

/** Whether the props make a heading (the `header` role, or `heading` on the web). */
function isHeading(props: TextProps): boolean {
  const role = (props as { role?: string }).role;
  return props.accessibilityRole === 'header' || role === 'heading';
}

/**
 * Themed text on the Stacks type scale, and the app's only Text component. A caller's
 * class replaces the variant's class for the same property and variant (`cn`), so
 * `<Text variant="caption" className="text-brand-ink">` recolours the caption in both
 * themes (the colour is one themed token, not a light/dark pair).
 */
export function Text({ variant = 'body', className, style, level, ...props }: AppTextProps) {
  const contextClass = useContext(TextClassContext);
  const heading =
    level !== undefined || isHeading(props)
      ? ({
          accessibilityRole: 'header',
          // React Native's types have no `aria-level`; react-native-web reads it (`hN`).
          'aria-level': level ?? headingLevelFor(variant),
        } as TextProps)
      : null;
  return (
    <RNText
      className={cn(variants[variant], contextClass, className)}
      style={
        Platform.OS === 'web' && isDisplay(variant)
          ? [WEB_DISPLAY_STYLE, style]
          : TABULAR.has(variant)
            ? [tabularNums, style]
            : style
      }
      maxFontSizeMultiplier={isDisplay(variant) ? DISPLAY_MAX_FONT_SCALE : undefined}
      {...heading}
      {...props}
    />
  );
}
