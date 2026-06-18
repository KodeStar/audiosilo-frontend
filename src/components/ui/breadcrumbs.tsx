import { Pressable, ScrollView } from 'react-native';

import { Text } from './text';

export type Crumb = { label: string; onPress?: () => void; active?: boolean };

/** Contiguous breadcrumb pills with hairline separators; the active (last) crumb
 * is pink. Ported from the old client's `.breadcrumbs`. */
export function BreadCrumbs({ crumbs }: { crumbs: Crumb[] }) {
  const last = crumbs.length - 1;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="grow-0"
      contentContainerClassName="flex-row items-center"
    >
      {crumbs.map((c, i) => (
        <Pressable
          key={`${c.label}-${i}`}
          onPress={c.onPress}
          disabled={!c.onPress}
          className={`bg-gray-100 px-3 py-1.5 active:opacity-80 dark:bg-gray-840 ${
            i === 0 ? 'rounded-l-md' : ''
          } ${i === last ? 'rounded-r-md' : 'border-r border-gray-200 dark:border-gray-800'}`}
        >
          <Text
            numberOfLines={1}
            className={
              c.active
                ? 'font-roboto-medium text-sm text-primary dark:text-primary'
                : 'text-sm text-gray-500 dark:text-gray-400'
            }
          >
            {c.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
