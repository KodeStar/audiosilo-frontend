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

const discoveryManager = { isRunning: async () => true };

const CastContext = {
  getSessionManager: () => sessionManager,
  getDiscoveryManager: () => discoveryManager,
  getPlayServicesState: async () => 'success',
  // A device found, so the SDK's button draws (a test spies on these for the others).
  getCastState: async (): Promise<string | null> => 'notConnected',
  onCastStateChanged: (_listener: (state: string) => void) => ({ remove() {} }),
  showCastDialog: async () => true,
};

export default CastContext;
export { CastContext };

export class RemoteMediaClient {}

export const PlayServicesState = { SUCCESS: 'success' } as const;

export const CastState = {
  NO_DEVICES_AVAILABLE: 'noDevicesAvailable',
  NOT_CONNECTED: 'notConnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
} as const;

export function CastButton(props: ViewProps & { tintColor?: string }) {
  return <View testID="sdk-cast-button" {...props} />;
}
