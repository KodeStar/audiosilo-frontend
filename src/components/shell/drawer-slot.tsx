import { View } from 'react-native';

import { UpNextDrawer } from '@/components/upnext/up-next-drawer';

/**
 * The desktop right-hand drawer region, beside the page (STYLEGUIDE section 2: 300-480,
 * resizable), between the top chrome and the docked player. Up next fills it
 * (`UpNextDrawer`), which renders nothing while it is hidden or the server has no queue.
 */
export function DrawerSlot() {
  return (
    <View testID="shell-drawer-slot" className="flex-row">
      <UpNextDrawer />
    </View>
  );
}
