import { createContext, type ReactNode, useContext, useState } from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { INLINE_MIN } from './settings-model';

/** Whether the card around a row is wide enough to put a wide control beside its label. */
const InlineContext = createContext(false);

/** A pane's card (the prototype's `card` around `SetRow`s): rows separated by hairlines.
 * It measures itself, so its rows put a wide control beside or under their label by the
 * room the card actually has. */
export function SettingsCard({ children, testID }: { children: ReactNode; testID?: string }) {
  const [width, setWidth] = useState(0);
  return (
    <Card
      testID={testID}
      className="overflow-hidden px-4 py-0 lg:px-5"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      <InlineContext.Provider value={width >= INLINE_MIN}>{children}</InlineContext.Provider>
    </Card>
  );
}

/**
 * One setting: its label, an optional description, and its control. A string
 * description is one caption line; pass nodes for several (each its own caption `Text`).
 * - `compact` (a stepper, a select): always beside the label.
 * - `wide` (a segmented control): beside it in a wide card, under it in a narrow one.
 * - `block` (a wrapping list, a status line): always under it, full width.
 * Every row but the card's first has a hairline above it.
 */
export function SettingRow({
  label,
  description,
  control = 'compact',
  first,
  children,
  testID,
}: {
  label: string;
  description?: ReactNode;
  control?: 'compact' | 'wide' | 'block';
  first?: boolean;
  children?: ReactNode;
  testID?: string;
}) {
  const wideCard = useContext(InlineContext);
  const inline = control === 'compact' || (control === 'wide' && wideCard);
  return (
    <View
      testID={testID}
      className={cn(
        'py-3.5',
        !first && 'border-t border-border',
        inline ? 'flex-row items-center justify-between gap-4' : 'gap-2.5',
      )}
    >
      <View className={cn('gap-0.5', inline && 'min-w-0 shrink')}>
        <Text>{label}</Text>
        {typeof description === 'string' && description ? (
          <Text variant="caption">{description}</Text>
        ) : (
          description || null
        )}
      </View>
      {children ? (
        <View className={control === 'wide' && inline ? 'w-[280px] shrink-0' : undefined}>
          {children}
        </View>
      ) : null}
    </View>
  );
}
