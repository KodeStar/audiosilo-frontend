import * as Device from 'expo-device';
import { Platform } from 'react-native';

/** Human-friendly device name sent as `device_name` when issuing a session. */
export function getDeviceName(): string {
  if (Device.deviceName) return Device.deviceName;
  const parts = [Device.osName, Device.modelName].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return Platform.OS === 'web' ? 'Web browser' : 'AudioSilo client';
}
