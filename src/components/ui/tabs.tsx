import * as TabsPrimitive from '@rn-primitives/tabs';
import { createContext, useContext } from 'react';
import { Platform, ScrollView } from 'react-native';

import { cn } from '@/lib/utils';

import { TextClassContext } from './text';
import { segmentActive } from './toggle-group';

/**
 * Stacks tabs (STYLEGUIDE.md section 8), on react-native-reusables' Tabs: a `tablist` of
 * `tab`s that each own a `tabpanel` (`TabsContent`). Two looks:
 * - `underline` (default): the book tabs and the player companion - a hairline row,
 *   the active tab in ink with a 2px ink underline.
 * - `segmented`: the sub-nav look - a muted track with the active tab raised on a card.
 *   (A segmented control that doesn't own panels is `SegmentedControl`, ./toggle-group.)
 *
 * `scrollable` puts the triggers in a horizontal scroller, so more tabs than fit a row
 * (the book screen has up to 7, and labels grow 30% in translation) stay reachable.
 */
type Variant = 'underline' | 'segmented';

const VariantContext = createContext<Variant>('underline');

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  children,
  variant = 'underline',
  scrollable = false,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & {
  className?: string;
  variant?: Variant;
  scrollable?: boolean;
}) {
  const row = variant === 'underline' ? 'flex-row gap-5' : 'flex-row gap-0.5';
  return (
    <VariantContext.Provider value={variant}>
      <TabsPrimitive.List
        className={cn(
          variant === 'underline'
            ? 'border-b border-border'
            : 'self-start rounded-[11px] border border-border bg-muted p-[3px]',
          !scrollable && row,
          className,
        )}
        {...props}
      >
        {scrollable ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName={row}
          >
            {children}
          </ScrollView>
        ) : (
          children
        )}
      </TabsPrimitive.List>
    </VariantContext.Provider>
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & { className?: string }) {
  const variant = useContext(VariantContext);
  const { value } = TabsPrimitive.useRootContext();
  const active = value === props.value;
  return (
    <TextClassContext.Provider
      value={cn('font-sans-semibold text-sm', active ? 'text-foreground' : 'text-muted-foreground')}
    >
      <TabsPrimitive.Trigger
        className={cn(
          'flex-row items-center justify-center gap-1.5',
          variant === 'underline'
            ? cn(
                // 42 tall + the underline overlapping the list's hairline (-mb-px).
                '-mb-px h-[42px] border-b-2',
                active ? 'border-foreground' : 'border-transparent',
              )
            : cn('h-[30px] rounded-lg border px-3', active ? segmentActive : 'border-transparent'),
          Platform.select({
            web: 'cursor-pointer select-none whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring',
          }),
          props.disabled && 'opacity-50',
          className,
        )}
        hitSlop={variant === 'segmented' ? { top: 7, bottom: 7 } : undefined}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content> & { className?: string }) {
  return (
    <TabsPrimitive.Content
      className={cn(Platform.select({ web: 'outline-none' }), className)}
      {...props}
    />
  );
}
