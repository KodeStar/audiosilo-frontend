import * as LabelPrimitive from '@rn-primitives/label';
import { useId, useState } from 'react';
import { Platform, TextInput, View, type TextInputProps } from 'react-native';

import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Text } from './text';

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
};

function useFocus(
  onFocus: TextInputProps['onFocus'],
  onBlur: TextInputProps['onBlur'],
): [boolean, Pick<TextInputProps, 'onFocus' | 'onBlur'>] {
  const [focused, setFocused] = useState(false);
  return [
    focused,
    {
      onFocus: (e) => {
        setFocused(true);
        onFocus?.(e);
      },
      onBlur: (e) => {
        setFocused(false);
        onBlur?.(e);
      },
    },
  ];
}

function borderClass(focused: boolean, invalid: boolean) {
  if (invalid) return 'border-destructive';
  return focused ? 'border-ring' : 'border-input';
}

/** The label + field + error column shared by Input and Textarea. */
function Field({
  id,
  label,
  error,
  containerClassName,
  children,
}: {
  id: string;
  label?: string;
  error?: string;
  containerClassName?: string;
  children: React.ReactNode;
}) {
  if (!label && !error) return <View className={containerClassName}>{children}</View>;
  return (
    <View className={cn('gap-1.5', containerClassName)}>
      {label ? (
        <LabelPrimitive.Text
          nativeID={`${id}-label`}
          htmlFor={id}
          className="font-sans-semibold text-xs uppercase tracking-wider text-muted-foreground"
        >
          {label}
        </LabelPrimitive.Text>
      ) : null}
      {children}
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
export function Input({
  className,
  size = 'default',
  label,
  error,
  containerClassName,
  onFocus,
  onBlur,
  editable,
  ...props
}: InputProps) {
  const themed = useThemeColors();
  const id = useFieldId();
  const [focused, focusProps] = useFocus(onFocus, onBlur);
  return (
    <Field id={id} label={label} error={error} containerClassName={containerClassName}>
      <TextInput
        nativeID={id}
        aria-labelledby={label ? `${id}-label` : undefined}
        accessibilityLabel={props.accessibilityLabel ?? label}
        aria-invalid={error ? true : undefined}
        placeholderTextColor={themed.subtleForeground}
        editable={editable}
        className={cn(
          fieldBase,
          sizes[size],
          borderClass(focused, !!error),
          editable === false && 'opacity-50',
          className,
        )}
        {...focusProps}
        {...props}
      />
    </Field>
  );
}

/** A multi-line text field (a note). Grows with its content up to the caller's limit. */
export function Textarea({
  className,
  label,
  error,
  containerClassName,
  onFocus,
  onBlur,
  editable,
  ...props
}: Omit<InputProps, 'size'>) {
  const themed = useThemeColors();
  const id = useFieldId();
  const [focused, focusProps] = useFocus(onFocus, onBlur);
  return (
    <Field id={id} label={label} error={error} containerClassName={containerClassName}>
      <TextInput
        multiline
        textAlignVertical="top"
        nativeID={id}
        aria-labelledby={label ? `${id}-label` : undefined}
        accessibilityLabel={props.accessibilityLabel ?? label}
        aria-invalid={error ? true : undefined}
        placeholderTextColor={themed.subtleForeground}
        editable={editable}
        className={cn(
          fieldBase,
          'min-h-[64px] py-2',
          Platform.select({ web: 'resize-y' }),
          borderClass(focused, !!error),
          editable === false && 'opacity-50',
          className,
        )}
        {...focusProps}
        {...props}
      />
    </Field>
  );
}

/** A DOM-safe id: React's `useId` contains colons, which break `label[for]` lookups in
 * some browsers' CSS selector paths. */
function useFieldId() {
  return `field-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}
