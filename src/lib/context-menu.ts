import type { RefObject } from 'react';
import type { View } from 'react-native';

/**
 * Web only (see `context-menu.web.ts`): a right-click, the Menu key or Shift+F10 on the
 * view behind `ref` asks for its context menu. Native has long-press for that.
 */
export function useContextMenuRequest(
  _ref: RefObject<View | null>,
  _onRequest: (() => void) | undefined,
): void {}
