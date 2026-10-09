// Jest: react-native-google-cast is a native module (no binary under Jest). Tests that
// exercise casting drive `src/cast` through fake drivers; this only lets components that
// render the SDK's Cast button, and modules that import the library, load.
import { View, type ViewProps } from 'react-native';

const sessionManager = {
  onSessionStarting: () => ({ remove() {} }),
  onSessionStarted: () => ({ remove() {} }),
  onSessionResumed: () => ({ remove() {} }),
  onSessionStartFailed: () => ({ remove() {} }),
  onSessionSuspended: () => ({ remove() {} }),
  onSessionEnding: () => ({ remove() {} }),
  onSessionEnded: () => ({ remove() {} }),
  getCurrentCastSession: async () => null,
  endCurrentSession: async () => {},
};

const CastContext = {
  getSessionManager: () => sessionManager,
  getPlayServicesState: async () => 'success',
  showCastDialog: async () => true,
};

export default CastContext;
export { CastContext };

export class RemoteMediaClient {}

export const PlayServicesState = { SUCCESS: 'success' } as const;

export function CastButton(props: ViewProps & { tintColor?: string }) {
  return <View testID="sdk-cast-button" {...props} />;
}
