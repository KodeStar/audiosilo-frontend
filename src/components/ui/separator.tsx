import * as SeparatorPrimitive from '@rn-primitives/separator';

import { cn } from '@/lib/utils';

/** A 1px hairline (`border`), horizontal or vertical: react-native-reusables' Separator.
 * Decorative by default (hidden from screen readers). */
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root> & { className?: string }) {
  return (
    <SeparatorPrimitive.Root
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}
