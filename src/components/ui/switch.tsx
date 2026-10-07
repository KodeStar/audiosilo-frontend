import * as SwitchPrimitives from '@rn-primitives/switch';
import { Platform, View } from 'react-native';

import { FOCUS_RING_OFFSET_CLASS } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * A Stacks switch (STYLEGUIDE.md section 8): react-native-reusables' Switch, restyled -
 * a 40x24 track that is `brand` when on (the guide's "switches on" pink) and
 * `border-strong` when off, with a white thumb. 44pt touch target via hitSlop. Give it
 * an `accessibilityLabel` (or put it beside a label that names it).
 */
export function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitives.Root> & { className?: string }) {
  return (
    <SwitchPrimitives.Root
      hitSlop={{ top: 10, bottom: 10, left: 2, right: 2 }}
      className={cn(
        'h-[24px] w-[40px] shrink-0 flex-row items-center rounded-full px-[3px]',
        props.checked ? 'bg-brand' : 'bg-border-strong',
        Platform.select({
          web: `cursor-pointer transition-colors motion-reduce:transition-none ${FOCUS_RING_OFFSET_CLASS}`,
        }),
        props.disabled && 'opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitives.Thumb asChild>
        <View
          className={cn(
            'h-[18px] w-[18px] rounded-full bg-white shadow-xs',
            props.checked ? 'translate-x-4' : 'translate-x-0',
            Platform.select({
              web: 'pointer-events-none transition-transform motion-reduce:transition-none',
            }),
          )}
        />
      </SwitchPrimitives.Thumb>
    </SwitchPrimitives.Root>
  );
}
