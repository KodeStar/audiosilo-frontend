import { useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';

import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Text } from './text';

export type TextFieldProps = TextInputProps & {
  label?: string;
  error?: string;
  className?: string;
  containerClassName?: string;
};

/**
 * Labeled text input with a brand focus ring, matching the old client's input
 * styling (rounded-xl, gray surface). The old "floating label" effect relied on
 * CSS `:placeholder-shown`; here the label sits above the field for parity
 * across native + web.
 */
export function TextField({
  label,
  error,
  className,
  containerClassName,
  onFocus,
  onBlur,
  ...props
}: TextFieldProps) {
  const themed = useThemeColors();
  const [focused, setFocused] = useState(false);
  return (
    <View className={cn('mb-4', containerClassName)}>
      {label ? (
        <Text variant="eyebrow" className="mb-1.5">
          {label}
        </Text>
      ) : null}
      <TextInput
        placeholderTextColor={themed.mutedForeground}
        className={cn(
          'rounded-xl border px-4 py-3 font-sans text-base text-foreground',
          'bg-card',
          error ? 'border-destructive' : focused ? 'border-brand' : 'border-border',
          className,
        )}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        {...props}
      />
      {error ? <Text className="mt-1 text-xs text-destructive">{error}</Text> : null}
    </View>
  );
}
