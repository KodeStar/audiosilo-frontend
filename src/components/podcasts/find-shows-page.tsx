import type { ReactNode } from 'react';
import { ScrollView } from 'react-native';

import { pageGutter } from '@/components/library/cover-layout';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { useLayout } from '@/lib/layout';

/** The Find shows page's scroller for a section without a long list (a feed address, an
 * import): the page head, then `children`, clear of the mini player. */
export function FindShowsScroll({
  header,
  children,
  testID,
}: {
  header: ReactNode;
  children: ReactNode;
  testID?: string;
}) {
  const gutter = pageGutter(useLayout());
  const paddingBottom = useMiniPlayerInset();
  return (
    <ScrollView
      testID={testID}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: paddingBottom + 24 }}
    >
      {header}
      {children}
    </ScrollView>
  );
}
