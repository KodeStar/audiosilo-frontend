import { NativeAppShell } from '@/components/shell/native-shell';

/**
 * The `(app)` group's layout: the native shell (`NativeAppShell`). The web shell is
 * `_layout.web.tsx`; on the web this file still loads (Expo Router reads every layout
 * file), which is why the shell itself lives in a module with an empty web stand-in.
 */
export default NativeAppShell;
