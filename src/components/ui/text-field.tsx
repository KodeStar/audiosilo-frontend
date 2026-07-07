import { useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';

import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

import { Text } from './text';

export type TextFieldProps = TextInputProps & {
  label?: string;
  error?: string;
  className?: string;
  containerClassName?: string;
};

/**
 * Labeled text input with a primary focus ring, matching the old client's input
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
  const [focused, setFocused] = useState(false);
  const { scheme } = useTheme();
  return (
    <View className={`mb-4 ${containerClassName ?? ''}`}>
      {label ? (
        <Text variant="label" className="mb-1.5">
          {label}
        </Text>
      ) : null}
      <TextInput
        placeholderTextColor={scheme === 'dark' ? colors.dark.text : colors.light.textMuted}
        className={[
          'rounded-xl border px-4 py-3 font-sans text-base text-gray-700 dark:text-gray-100',
          'bg-gray-100 dark:bg-gray-840',
          error
            ? 'border-red-500'
            : focused
              ? 'border-primary'
              : 'border-gray-200 dark:border-gray-750',
          className ?? '',
        ].join(' ')}
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
      {error ? <Text className="mt-1 text-xs text-red-500">{error}</Text> : null}
    </View>
  );
}
