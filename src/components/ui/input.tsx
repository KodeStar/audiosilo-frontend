import * as LabelPrimitive from '@rn-primitives/label';
import { useState, type Ref } from 'react';
import { Platform, TextInput, View, type TextInputProps } from 'react-native';

import { useDomId } from '@/lib/use-dom-id';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { EYEBROW_CLASS, Text } from './text';

/**
 * Stacks inputs (STYLEGUIDE.md section 8): react-native-reusables' Input and Textarea,
 * restyled. 40 tall (48 for the invite code and server address), radius 10, a `card`
 * fill, and focus = the `ring` border plus (web) a 3px 20% ring. Native has no CSS
 * `:focus`, so focus is tracked in state and drives the border on every platform.
 */
const fieldBase = cn(
  'w-full min-w-0 rounded-control border bg-card px-3 font-sans text-base text-foreground',
  Platform.select({
    web: 'outline-none transition-[border-color,box-shadow] focus:ring-[3px] focus:ring-ring/20',
  }),
);

const sizes = { default: 'h-[40px]', lg: 'h-[48px]' } as const;

export type InputProps = TextInputProps & {
  className?: string;
  /** 40 (default) or 48 tall (the invite code and server address). */
  size?: keyof typeof sizes;
  /** A label above the field, linked to it for screen readers (and click-to-focus on web). */
  label?: string;
  /** An error under the field; marks it invalid (destructive border, `aria-invalid`). */
  error?: string;
  /** Classes for the wrapper holding the label, field and error. */
  containerClassName?: string;
  /** The native field, e.g. to focus it (React 19 passes `ref` as a prop). */
  ref?: Ref<TextInput>;
};

/**
 * The one field implementation behind Input and Textarea: the label + field + error
 * column, the focus border, the label/error wiring. `shapeClassName` is the only
 * difference between the two (a fixed height, or a growing multi-line box).
 */
function TextField({
  shapeClassName,
  className,
  label,
  error,
  containerClassName,
  onFocus,
  onBlur,
  editable,
  ...props
}: Omit<InputProps, 'size'> & { shapeClassName: string }) {
  const themed = useThemeColors();
  const id = useDomId('field');
  const [focused, setFocused] = useState(false);
  const border = error ? 'border-destructive' : focused ? 'border-ring' : 'border-input';
  const field = (
    <TextInput
      nativeID={id}
      aria-labelledby={label ? `${id}-label` : undefined}
      accessibilityLabel={props.accessibilityLabel ?? label}
      aria-invalid={error ? true : undefined}
      placeholderTextColor={themed.subtleForeground}
      editable={editable}
      className={cn(
        fieldBase,
        shapeClassName,
        border,
        editable === false && 'opacity-50',
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
  );
  if (!label && !error) return <View className={containerClassName}>{field}</View>;
  return (
    <View className={cn('gap-1.5', containerClassName)}>
      {label ? (
        <LabelPrimitive.Text nativeID={`${id}-label`} htmlFor={id} className={EYEBROW_CLASS}>
          {label}
        </LabelPrimitive.Text>
      ) : null}
      {field}
      {error ? (
        <Text
          variant="caption"
          className="text-destructive"
          accessibilityLiveRegion="polite"
          role="alert"
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** A single-line text field. */
export function Input({ size = 'default', ...props }: InputProps) {
  return <TextField shapeClassName={sizes[size]} {...props} />;
}

/** A multi-line text field (a note). Grows with its content up to the caller's limit. */
export function Textarea(props: Omit<InputProps, 'size'>) {
  return (
    <TextField
      multiline
      textAlignVertical="top"
      shapeClassName={cn('min-h-[64px] py-2', Platform.select({ web: 'resize-y' }))}
      {...props}
    />
  );
}
