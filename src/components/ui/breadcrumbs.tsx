import { Pressable, ScrollView } from 'react-native';

import { HORIZONTAL_SCROLLER } from './horizontal-scroller';
import { Text } from './text';

export type Crumb = { label: string; onPress?: () => void; active?: boolean };

/**
 * The crumbs of a place in a library: the library (`root`), then each folder of `path`,
 * the last one (where the reader is) active and not a link. `open` goes to a folder by
 * its library-relative path ('' for the library itself).
 */
export function pathCrumbs(root: string, path: string, open: (sub: string) => void): Crumb[] {
  const segments = path.split('/').filter(Boolean);
  return [
    {
      label: root,
      active: segments.length === 0,
      onPress: segments.length === 0 ? undefined : () => open(''),
    },
    ...segments.map((seg, i) => {
      const isLast = i === segments.length - 1;
      const sub = segments.slice(0, i + 1).join('/');
      return { label: seg, active: isLast, onPress: isLast ? undefined : () => open(sub) };
    }),
  ];
}

/**
 * A book's crumbs (PLAYER-08): `pathCrumbs`, the last one (the book's own folder or file,
 * on disk often "02 - Caliban's War") named by the book's `title` as the page heading is.
 */
export function bookCrumbs(
  root: string,
  path: string,
  title: string,
  open: (sub: string) => void,
): Crumb[] {
  const crumbs = pathCrumbs(root, path, open);
  if (crumbs.length < 2 || !title) return crumbs;
  const last = crumbs.length - 1;
  return [...crumbs.slice(0, last), { ...crumbs[last], label: title }];
}

/** Contiguous breadcrumb pills with hairline separators; the active (last) crumb
 * is pink. Ported from the old client's `.breadcrumbs`. */
export function BreadCrumbs({ crumbs }: { crumbs: Crumb[] }) {
  const last = crumbs.length - 1;
  return (
    <ScrollView
      horizontal
      style={HORIZONTAL_SCROLLER}
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="flex-row items-center"
    >
      {crumbs.map((c, i) => (
        <Pressable
          key={`${c.label}-${i}`}
          onPress={c.onPress}
          disabled={!c.onPress}
          className={`bg-muted px-3 py-1.5 active:opacity-80 ${
            i === 0 ? 'rounded-l-md' : ''
          } ${i === last ? 'rounded-r-md' : 'border-r border-border'}`}
        >
          <Text
            numberOfLines={1}
            className={c.active ? 'font-sans-medium text-sm text-brand-ink' : 'text-sm'}
          >
            {c.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
