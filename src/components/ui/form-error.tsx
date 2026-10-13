import { Text } from './text';

/** A form's error line in the destructive colour, read out as it appears (a polite live
 * region). Renders nothing without an `error`. */
export function FormError({
  error,
  testID,
}: {
  error: string | null | undefined;
  testID?: string;
}) {
  if (!error) return null;
  return (
    <Text testID={testID} className="text-sm text-destructive" accessibilityLiveRegion="polite">
      {error}
    </Text>
  );
}
