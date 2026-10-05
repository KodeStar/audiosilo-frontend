import * as ToggleGroupPrimitive from '@rn-primitives/toggle-group';
import { Platform, ScrollView } from 'react-native';

import { cn } from '@/lib/utils';

import { Text, TextClassContext } from './text';

/**
 * The Stacks segmented control (STYLEGUIDE.md section 8: "muted track + raised card for
 * the active item"), built on react-native-reusables' ToggleGroup in `single` mode.
 *
 * It is a single choice that switches something in place, so it carries radio
 * semantics: the track is a `radiogroup` and each segment a `radio` whose `checked`
 * state says which is chosen (rn-primitives on native; set explicitly on web, where
 * rn-primitives would otherwise mark the items as plain buttons). For tabs that own a
 * panel, use `Tabs` (./tabs) instead.
 */
const track = 'rounded-[11px] border border-border bg-muted p-[3px]';

const itemBase = cn(
  'h-[30px] flex-row items-center justify-center gap-1.5 rounded-lg border border-transparent px-3',
  Platform.select({
    web: 'cursor-pointer select-none whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
  }),
);

// The raised segment. Dark mode lifts it to `secondary`: the dark `card` is darker
// than the `muted` track, so a card-coloured segment would read as sunken.
const segmentActive =
  'border-border bg-card shadow-xs dark:border-border-strong dark:bg-secondary dark:shadow-none';

export function ToggleGroup({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & { className?: string }) {
  return (
    <ToggleGroupPrimitive.Root
      role={props.type === 'single' ? 'radiogroup' : 'group'}
      className={cn('flex-row gap-0.5', track, className)}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Root>
  );
}

export function ToggleGroupItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & { className?: string }) {
  const { value, type, onValueChange } = ToggleGroupPrimitive.useRootContext();
  const selected = ToggleGroupPrimitive.utils.getIsSelected(value, props.value);
  const single = type === 'single';
  return (
    <TextClassContext.Provider
      value={cn(
        'font-sans-semibold text-sm',
        selected ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <ToggleGroupPrimitive.Item
        // A 30 tall segment in a 36 track; the slop makes the touch target 44.
        hitSlop={{ top: 7, bottom: 7 }}
        className={cn(
          itemBase,
          selected && segmentActive,
          props.disabled && 'opacity-50',
          className,
        )}
        {...(Platform.OS === 'web' && {
          role: single ? 'radio' : 'checkbox',
          'aria-checked': selected,
          // Space selects (react-native-web only activates role="button" on Space).
          onKeyDown: (e: { key?: string; preventDefault: () => void }) => {
            if (e.key !== ' ' && e.key !== 'Spacebar') return;
            e.preventDefault();
            if (single) {
              if (!selected) (onValueChange as (v: string) => void)(props.value);
            } else {
              const current = (value as string[] | undefined) ?? [];
              (onValueChange as (v: string[]) => void)(
                selected ? current.filter((v) => v !== props.value) : [...current, props.value],
              );
            }
          },
        })}
        {...props}
      >
        {children}
      </ToggleGroupPrimitive.Item>
    </TextClassContext.Provider>
  );
}

export type SegmentedOption<T extends string> = { value: T; label: string };

/**
 * A typed one-of-N segmented control over a string union: the common case of
 * `ToggleGroup type="single"` with one text segment per option. Pressing the chosen
 * segment again keeps it chosen (a toggle group would otherwise clear it).
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  grow,
  scrollable,
  wrap,
  accessibilityLabel,
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Equal-width segments filling the row. Ignored when `scrollable` (a scroller has
   * no width to divide, and a flex-1 segment in one collapses to nothing). */
  grow?: boolean;
  /** Scroll horizontally when the options don't fit (long labels, many options). */
  scrollable?: boolean;
  /** Wrap onto more lines instead (a long list such as the languages). */
  wrap?: boolean;
  /** The group's accessible name: what is being chosen ("Reading order"). */
  accessibilityLabel?: string;
  className?: string;
}) {
  const items = options.map((o) => (
    <ToggleGroupItem
      key={o.value}
      value={o.value}
      accessibilityLabel={o.label}
      className={grow && !scrollable ? 'flex-1' : undefined}
    >
      <Text numberOfLines={1}>{o.label}</Text>
    </ToggleGroupItem>
  ));
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as T);
      }}
      accessibilityLabel={accessibilityLabel}
      className={cn(wrap && 'flex-wrap', scrollable && 'flex-col', className)}
    >
      {scrollable ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="flex-row gap-0.5"
        >
          {items}
        </ScrollView>
      ) : (
        items
      )}
    </ToggleGroup>
  );
}
