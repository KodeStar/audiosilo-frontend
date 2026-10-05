import { cva, type VariantProps } from 'class-variance-authority';
import { View, type ViewProps } from 'react-native';

import { cn } from '@/lib/utils';

import { TextClassContext } from './text';

/**
 * A Stacks badge (STYLEGUIDE.md section 8): react-native-reusables' Badge, restyled to
 * the guide's 22-tall pill and its nine tones. Status badges pair the colour with a
 * word (and an icon where there is room): colour alone never carries meaning.
 */
const badgeVariants = cva('h-[22px] shrink-0 flex-row items-center gap-1 rounded-full px-2', {
  variants: {
    variant: {
      secondary: 'bg-secondary',
      outline: 'border border-border-strong',
      ink: 'bg-primary',
      success: 'bg-success-soft',
      warning: 'bg-warning-soft',
      destructive: 'bg-destructive-soft',
      info: 'bg-info-soft',
      brand: 'bg-brand-soft',
      community: 'bg-community-soft',
    },
  },
  defaultVariants: { variant: 'secondary' },
});

const badgeTextVariants = cva('font-sans-semibold text-xs', {
  variants: {
    variant: {
      secondary: 'text-secondary-foreground',
      outline: 'text-muted-foreground',
      ink: 'text-primary-foreground',
      success: 'text-success',
      warning: 'text-warning',
      destructive: 'text-destructive',
      info: 'text-info',
      brand: 'text-brand-ink',
      community: 'text-community',
    },
  },
  defaultVariants: { variant: 'secondary' },
});

export type BadgeProps = ViewProps &
  VariantProps<typeof badgeVariants> & {
    className?: string;
  };

/** `<Badge variant="success"><Text>Finished</Text></Badge>`: the Text inherits the tone. */
export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <TextClassContext.Provider value={badgeTextVariants({ variant })}>
      <View className={cn(badgeVariants({ variant }), className)} {...props} />
    </TextClassContext.Provider>
  );
}
