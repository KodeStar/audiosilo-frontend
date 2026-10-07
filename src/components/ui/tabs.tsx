import * as TabsPrimitive from '@rn-primitives/tabs';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';

import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { AnimatedPressable } from './animated-pressable';
import { HORIZONTAL_SCROLLER } from './horizontal-scroller';
import { Icon } from './icon';
import { FOCUS_RING_CLASS, TextClassContext } from './text';

/**
 * Stacks tabs (STYLEGUIDE.md section 8), on react-native-reusables' Tabs: a `tablist` of
 * `tab`s that each own a `tabpanel` (`TabsContent`), in the underline look (the book tabs
 * and the player companion): a hairline row, the active tab in ink with a 2px ink
 * underline. (A segmented control that doesn't own panels is `SegmentedControl`,
 * ./toggle-group.)
 *
 * `scrollable` puts the triggers in a horizontal scroller, so more tabs than fit a row
 * (the book screen has up to 7, and labels grow 30% in translation) stay reachable. When
 * they overflow, a chevron after the row says so and pages it (a mouse has no sideways
 * swipe); the keyboard reaches every tab anyway (focus scrolls it into view).
 */
export const Tabs = TabsPrimitive.Root;

const ROW = 'flex-row gap-5';

/** Where a scrolling tab row is: how wide it shows, how wide its tabs are, how far in. */
type RowBox = { view: number; content: number; x: number };

/** The overflow cue for a scrolling tab row: which way the chevron pages, or none while
 * every tab fits. Pure. */
export function tabsScrollCue({ view, content, x }: RowBox): 'forward' | 'back' | null {
  if (view <= 0 || content <= view + 1) return null;
  return x + view >= content - 1 ? 'back' : 'forward';
}

export function TabsList({
  className,
  children,
  scrollable = false,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & {
  className?: string;
  scrollable?: boolean;
}) {
  if (!scrollable) {
    return (
      <TabsPrimitive.List className={cn('border-b border-border', ROW, className)} {...props}>
        {children}
      </TabsPrimitive.List>
    );
  }
  return (
    <ScrollingTabsList className={className} listProps={props}>
      {children}
    </ScrollingTabsList>
  );
}

function ScrollingTabsList({
  className,
  children,
  listProps,
}: {
  className?: string;
  children?: React.ReactNode;
  listProps: Omit<React.ComponentProps<typeof TabsPrimitive.List>, 'children'>;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const scroller = useRef<ScrollView>(null);
  // Where the row is, in refs (a scroll event must not re-render the row); only the cue
  // it yields is state, so the row re-renders when the chevron changes, not per frame.
  const box = useRef<RowBox>({ view: 0, content: 0, x: 0 });
  const [cue, setCue] = useState<ReturnType<typeof tabsScrollCue>>(null);
  const update = (patch: Partial<RowBox>) => {
    box.current = { ...box.current, ...patch };
    setCue(tabsScrollCue(box.current));
  };
  const page = () => {
    const { view, content, x } = box.current;
    scroller.current?.scrollTo({
      x: cue === 'forward' ? Math.min(content - view, x + view * 0.8) : 0,
      animated: true,
    });
  };
  return (
    // The cue sits beside the tablist, not in it (a tablist holds only tabs).
    <View className={cn('flex-row items-center border-b border-border', className)}>
      <TabsPrimitive.List className="min-w-0 flex-1" {...listProps}>
        <ScrollView
          ref={scroller}
          testID="tabs-scroller"
          horizontal
          style={HORIZONTAL_SCROLLER}
          showsHorizontalScrollIndicator={false}
          contentContainerClassName={ROW}
          scrollEventThrottle={32}
          onLayout={(e) => update({ view: e.nativeEvent.layout.width })}
          onContentSizeChange={(content) => update({ content })}
          onScroll={(e) => update({ x: e.nativeEvent.contentOffset.x })}
        >
          {children}
        </ScrollView>
      </TabsPrimitive.List>
      {cue ? (
        <AnimatedPressable
          testID="tabs-scroll-cue"
          onPress={page}
          accessibilityRole="button"
          accessibilityLabel={cue === 'forward' ? t('ui.tabs.more') : t('ui.tabs.earlier')}
          hitSlop={4}
          className={cn(
            '-mr-2 ml-1 h-10 w-9 items-center justify-center rounded-full active:bg-accent',
            Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
          )}
        >
          <View style={cue === 'back' ? { transform: [{ scaleX: -1 }] } : undefined}>
            <Icon name="chevron-right" size={14} color={themed.mutedForeground} />
          </View>
        </AnimatedPressable>
      ) : null}
    </View>
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
