import { View } from 'react-native';

/**
 * The desktop right-hand drawer region, beside the page (STYLEGUIDE section 2: 300-480,
 * resizable). The Up next drawer fills it in Phase 2; until there is a queue it is
 * closed (zero width) and nothing opens it - only the layout slot exists.
 */
export function DrawerSlot() {
  return (
    <View
      testID="shell-drawer-slot"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ width: 0 }}
    />
  );
}
