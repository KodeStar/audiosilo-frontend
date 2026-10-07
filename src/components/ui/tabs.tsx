import * as TabsPrimitive from '@rn-primitives/tabs';
import { Platform, ScrollView } from 'react-native';

import { cn } from '@/lib/utils';

import { HORIZONTAL_SCROLLER } from './horizontal-scroller';
import { FOCUS_RING_CLASS, TextClassContext } from './text';

/**
 * Stacks tabs (STYLEGUIDE.md section 8), on react-native-reusables' Tabs: a `tablist` of
 * `tab`s that each own a `tabpanel` (`TabsContent`), in the underline look (the book tabs
 * and the player companion): a hairline row, the active tab in ink with a 2px ink
 * underline. (A segmented control that doesn't own panels is `SegmentedControl`,
 * ./toggle-group.)
 *
 * `scrollable` puts the triggers in a horizontal scroller, so more tabs than fit a row
 * (the book screen has up to 7, and labels grow 30% in translation) stay reachable.
 */
export const Tabs = TabsPrimitive.Root;

const ROW = 'flex-row gap-5';

export function TabsList({
  className,
  children,
  scrollable = false,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & {
  className?: string;
  scrollable?: boolean;
}) {
  return (
    <TabsPrimitive.List
      className={cn('border-b border-border', !scrollable && ROW, className)}
      {...props}
    >
      {scrollable ? (
        <ScrollView
          testID="tabs-scroller"
          horizontal
          style={HORIZONTAL_SCROLLER}
          showsHorizontalScrollIndicator={false}
          contentContainerClassName={ROW}
        >
          {children}
        </ScrollView>
      ) : (
        children
      )}
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & { className?: string }) {
  const { value } = TabsPrimitive.useRootContext();
  const active = value === props.value;
  return (
    <TextClassContext.Provider
      value={cn('font-sans-semibold text-sm', active ? 'text-foreground' : 'text-muted-foreground')}
    >
      <TabsPrimitive.Trigger
        className={cn(
          // 42 tall + the underline overlapping the list's hairline (-mb-px).
          '-mb-px h-[42px] flex-row items-center justify-center gap-1.5 border-b-2',
          active ? 'border-foreground' : 'border-transparent',
          Platform.select({
            web: `cursor-pointer select-none whitespace-nowrap ${FOCUS_RING_CLASS}`,
          }),
          props.disabled && 'opacity-50',
          className,
        )}
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
