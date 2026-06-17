import { Pressable, ScrollView } from 'react-native';

import { Text } from './text';

export type Crumb = { label: string; onPress?: () => void; active?: boolean };

/** Horizontal breadcrumb pills, ported from the old client's `.breadcrumbs`. */
export function BreadCrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="mb-6 mt-2 grow-0"
      contentContainerClassName="flex-row items-center"
    >
      {crumbs.map((c, i) => (
        <Pressable
          key={`${c.label}-${i}`}
          onPress={c.onPress}
          disabled={!c.onPress}
          className="border-r border-gray-200 px-3 py-1 active:bg-gray-50 dark:border-gray-800 dark:active:bg-gray-840"
        >
          <Text
            className={
              c.active
                ? 'font-roboto-medium text-sm text-primary'
                : 'text-sm text-gray-600 dark:text-gray-400'
            }
          >
            {c.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
