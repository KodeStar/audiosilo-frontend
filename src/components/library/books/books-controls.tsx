import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useLayout } from '@/lib/layout';
import { useThemeColors } from '@/theme/use-theme-colors';

import type { BooksLayout } from './books-layout-store';
import { BOOKS_SORTS, type BooksSort } from './books-view';

const SORT_LABEL_KEY = {
  recent: 'library.books.sort.recent',
  title: 'library.books.sort.title',
  author: 'library.books.sort.author',
  length: 'library.books.sort.length',
} as const satisfies Record<BooksSort, string>;

/** The sort menu: an outline button naming the current order (just its glyph on a
 * tablet, whose sub-nav row also holds the sections and the library picker), a menu of
 * the four. */
function SortMenu({ value, onChange }: { value: BooksSort; onChange: (sort: BooksSort) => void }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const compact = useLayout() === 'tablet';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          icon="sort"
          title={compact ? undefined : t(SORT_LABEL_KEY[value])}
          accessibilityLabel={t('library.books.sort.label', { sort: t(SORT_LABEL_KEY[value]) })}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('library.books.sort.heading')}</DropdownMenuLabel>
        {BOOKS_SORTS.map((s) => (
          <DropdownMenuItem
            key={s}
            onPress={() => onChange(s)}
            accessibilityState={{ checked: s === value }}
          >
            <Text className="flex-1">{t(SORT_LABEL_KEY[s])}</Text>
            {s === value ? <Icon name="check" size={16} color={themed.foreground} /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Grid or list, as a two-glyph segmented control. */
export function LayoutToggle({
  value,
  onChange,
}: {
  value: BooksLayout;
  onChange: (layout: BooksLayout) => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const glyph = (layout: BooksLayout) => (
    <Icon
      name={layout}
      size={15}
      color={layout === value ? themed.foreground : themed.mutedForeground}
    />
  );
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as BooksLayout);
      }}
      accessibilityLabel={t('library.books.layout.label')}
    >
      <ToggleGroupItem value="grid" accessibilityLabel={t('library.books.layout.grid')}>
        {glyph('grid')}
      </ToggleGroupItem>
      <ToggleGroupItem value="list" accessibilityLabel={t('library.books.layout.list')}>
        {glyph('list')}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

/** The Books mode's contextual actions: sort, then grid/list (published to the sub-nav
 * on tablet/desktop, in the page on a phone). */
export function BooksControls({
  sort,
  onSort,
  layout,
  onLayout,
}: {
  sort: BooksSort;
  onSort: (sort: BooksSort) => void;
  layout: BooksLayout;
  onLayout: (layout: BooksLayout) => void;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <SortMenu value={sort} onChange={onSort} />
      <LayoutToggle value={layout} onChange={onLayout} />
    </View>
  );
}
