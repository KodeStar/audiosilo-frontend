import { Text as RNText, type TextProps } from 'react-native';

import { cn } from '@/lib/utils';

type Variant = 'body' | 'muted' | 'heading' | 'title' | 'subtitle' | 'label' | 'caption';

const variants: Record<Variant, string> = {
  body: 'font-sans text-base text-gray-600 dark:text-gray-400',
  muted: 'font-sans text-sm text-gray-500 dark:text-gray-500',
  heading: 'font-roboto-semibold text-xl text-gray-700 dark:text-gray-100',
  title: 'font-roboto-medium text-lg text-gray-700 dark:text-gray-200',
  subtitle: 'font-roboto-medium text-sm text-gray-700 dark:text-gray-200',
  label: 'font-roboto-regular text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400',
  caption: 'font-sans text-xs text-gray-500 dark:text-gray-500',
};

export type AppTextProps = TextProps & { variant?: Variant; className?: string };

/** Themed text. A caller's `className` wins over the variant's classes (`cn`). */
export function Text({ variant = 'body', className, ...props }: AppTextProps) {
  return <RNText className={cn(variants[variant], className)} {...props} />;
}
