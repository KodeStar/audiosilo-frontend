import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';

import { checkRowClass } from '@/components/ui/check-row';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FilterChip } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatCount } from '@/lib/format';
import { type LabelKind, labelKey } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import type { LabelOption } from './books-view';

const KEYS = {
  genre: {
    chip: 'library.books.filters.genre',
    chosen: 'library.books.filters.genreChosen',
    any: 'library.books.filters.anyGenre',
  },
  tag: {
    chip: 'library.books.filters.tag',
    chosen: 'library.books.filters.tagChosen',
    any: 'library.books.filters.anyTag',
  },
} as const satisfies Record<LabelKind, { chip: string; chosen: string; any: string }>;

/**
 * The Books mode's genre or tag filter: a picker chip in the filter row naming the
 * filter ("Genre"), or the chosen label with its count, opening a dialog (a sheet on a
 * phone) of every choice with its count (`labelOptions`) and "Any genre" to drop it.
 * There can be hundreds of tags, too many for chips of their own.
 */
export function LabelFilter({
  kind,
  value,
  options,
  loading,
  onChange,
}: {
  kind: LabelKind;
  /** The chosen label (the URL's spelling), if any. */
  value?: string;
  options: LabelOption[];
  /** The library is still loading: no count yet. */
  loading: boolean;
  onChange: (label: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const keys = KEYS[kind];
  const chosenKey = value ? labelKey(value) : '';
  const chosen = chosenKey ? options.find((o) => o.key === chosenKey) : undefined;
  const name = chosen?.name ?? value;
  const pick = (label: string | undefined) => {
    setOpen(false);
    onChange(label);
  };
  return (
    <>
      <FilterChip
        picker
        label={name ?? t(keys.chip)}
        accessibilityLabel={name ? t(keys.chosen, { name }) : undefined}
        count={name && !loading ? (chosen?.count ?? 0) : undefined}
        selected={!!name}
        onPress={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader className="pr-10">
            <DialogTitle>{t(keys.chip)}</DialogTitle>
          </DialogHeader>
          <ScrollView
            className="max-h-[360px]"
            contentContainerClassName="gap-0.5"
            role="radiogroup"
          >
            <ChoiceRow label={t(keys.any)} checked={!chosenKey} onPress={() => pick(undefined)} />
            {options.map((o) => (
              <ChoiceRow
                key={o.key}
                label={o.name}
                count={o.count}
                checked={o.key === chosenKey}
                onPress={() => pick(o.name)}
              />
            ))}
          </ScrollView>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** One choice: its name, its count (subtle tabular figures) and a check when chosen. */
function ChoiceRow({
  label,
  count,
  checked,
  onPress,
}: {
  label: string;
  count?: number;
  checked: boolean;
  onPress: () => void;
}) {
  const themed = useThemeColors();
  return (
    <Pressable
      role="radio"
      aria-checked={checked}
      accessibilityState={{ checked }}
      accessibilityLabel={count === undefined ? label : `${label}, ${count}`}
      onPress={onPress}
      className={cn(checkRowClass, 'min-h-[44px]')}
    >
      <Text variant="label" className="flex-1" numberOfLines={1}>
        {label}
      </Text>
      {count === undefined ? null : (
        <Text variant="caption" style={tabularNums}>
          {formatCount(count)}
        </Text>
      )}
      <View className="w-4">
        {checked ? <Icon name="check" size={16} color={themed.foreground} /> : null}
      </View>
    </Pressable>
  );
}
