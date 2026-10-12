import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

import { claimPageTitle } from './document-title';

/**
 * Name the browser tab after this screen while it is focused (`undefined` while its data
 * loads: the tab's name stands in). Focus, not mount: a Stack keeps the pages under the
 * top one mounted, and the page Back returns to must name the tab again.
 */
export function usePageTitle(title: string | undefined) {
  useFocusEffect(useCallback(() => (title ? claimPageTitle(title) : undefined), [title]));
}
