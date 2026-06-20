import Constants from 'expo-constants';
import { useState } from 'react';
import { Image, Pressable, ScrollView, Share, View } from 'react-native';

import { ApiError } from '@/api/client';
import { useServerInfo } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import type { PairingPayload } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Stepper } from '@/components/ui/stepper';
import { Text } from '@/components/ui/text';
import { useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import { useTheme, type SchemePref } from '@/theme/theme-provider';

const APPEARANCE: { value: SchemePref; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

const sec = (v: number) => `${v}s`;
const secOrOff = (v: number) => (v === 0 ? 'Off' : `${v}s`);
const speed = (v: number) => `${Number(v.toFixed(2))}×`;

export default function SettingsScreen() {
  const { pref, setPref } = useTheme();
  const api = useOptionalApi();
  const { data: server } = useServerInfo();
  const user = useSession((s) => s.user);
  const serverUrl = useSession((s) => s.serverUrl);
  const logout = useSession((s) => s.logout);

  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const defaultRate = useSettings((s) => s.defaultRate);
  const autoRewindMax = useSettings((s) => s.autoRewindMax);
  const setSkipForward = useSettings((s) => s.setSkipForward);
  const setSkipBackward = useSettings((s) => s.setSkipBackward);
  const setDefaultRate = useSettings((s) => s.setDefaultRate);
  const setAutoRewindMax = useSettings((s) => s.setAutoRewindMax);

  const onLogout = async () => {
    try {
      await api?.logout();
    } catch {
      // ignore; clear locally regardless
    }
    await logout();
  };

  // Self-service device pairing: mint a fresh pairing QR for the signed-in user so
  // another device can scan it (or open the link) and pair without an admin.
  const [pairing, setPairing] = useState<PairingPayload | null>(null);
  const [pairLoading, setPairLoading] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  const onAddDevice = async () => {
    if (!api) return;
    setPairError(null);
    setPairLoading(true);
    try {
      setPairing(await api.pair());
    } catch (e) {
      setPairError(e instanceof ApiError ? e.message : 'Could not reach the server.');
    } finally {
      setPairLoading(false);
    }
  };

  const shareLink = async () => {
    if (!pairing) return;
    try {
      await Share.share({ message: pairing.web_url });
    } catch {
      // user dismissed, or sharing is unavailable on this platform
    }
  };

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-6 p-4 px-8">
      <Text variant="heading">Settings</Text>

      <View className="gap-2">
        <Text variant="label">Appearance</Text>
        <Card className="flex-row gap-2 p-2">
          {APPEARANCE.map((o) => {
            const active = pref === o.value;
            return (
              <Pressable
                key={o.value}
                onPress={() => setPref(o.value)}
                className={`flex-1 items-center rounded-md px-3 py-2 ${active ? 'bg-primary' : 'bg-gray-100 dark:bg-gray-860'}`}
              >
                <Text
                  className={`font-roboto-medium ${active ? 'text-white dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}
                >
                  {o.label}
                </Text>
              </Pressable>
            );
          })}
        </Card>
      </View>

      <View className="gap-2">
        <Text variant="label">Playback</Text>
        <Card className="gap-4">
          <View className="flex-row items-center justify-between">
            <Text>Skip back</Text>
            <Stepper
              value={skipBackward}
              onChange={setSkipBackward}
              step={5}
              min={5}
              max={120}
              format={sec}
            />
          </View>
          <View className="flex-row items-center justify-between">
            <Text>Skip forward</Text>
            <Stepper
              value={skipForward}
              onChange={setSkipForward}
              step={5}
              min={5}
              max={120}
              format={sec}
            />
          </View>
          <View className="flex-row items-center justify-between">
            <Text>Default speed</Text>
            <Stepper
              value={defaultRate}
              onChange={setDefaultRate}
              step={0.05}
              min={0.5}
              max={2}
              format={speed}
            />
          </View>
          <View className="flex-row items-center justify-between">
            <Text>Auto-rewind on resume</Text>
            <Stepper
              value={autoRewindMax}
              onChange={setAutoRewindMax}
              step={5}
              min={0}
              max={30}
              format={secOrOff}
            />
          </View>
        </Card>
      </View>

      <View className="gap-2">
        <Text variant="label">Account</Text>
        <Card className="gap-3">
          <View>
            <Text variant="subtitle">{user?.username ?? 'Signed in'}</Text>
            <Text variant="muted">
              {user?.role === 'admin' ? 'Administrator' : 'User'}
              {serverUrl ? ` · ${serverUrl.replace(/^https?:\/\//, '')}` : ''}
            </Text>
          </View>
          <Button title="Sign out" variant="secondary" icon="logout" onPress={onLogout} />
        </Card>
      </View>

      <View className="gap-2">
        <Text variant="label">Devices</Text>
        <Card className="gap-3">
          {pairing ? (
            <View className="items-center gap-3">
              <Text variant="muted" className="text-center">
                On the other device, open AudioSilo and scan this code — or open the link below.
              </Text>
              <Image
                source={{ uri: pairing.qr_png_data_uri }}
                style={{ width: 220, height: 220 }}
                className="self-center rounded-lg bg-white p-2"
              />
              <Text selectable variant="muted" className="text-center text-xs">
                {pairing.web_url}
              </Text>
              <View className="flex-row gap-2">
                <Button title="Share link" variant="secondary" icon="qrcode" onPress={shareLink} />
                <Button title="Done" variant="secondary" onPress={() => setPairing(null)} />
              </View>
            </View>
          ) : (
            <>
              <Text variant="muted">Pair another phone, tablet, or browser to this account.</Text>
              {pairError ? <Text className="text-sm text-red-500">{pairError}</Text> : null}
              {pairLoading ? (
                <Spinner />
              ) : (
                <Button title="Add a device" icon="qrcode" onPress={onAddDevice} />
              )}
            </>
          )}
        </Card>
      </View>

      <Text variant="caption" className="text-center">
        AudioSilo v{server?.version ?? Constants.expoConfig?.version ?? '1.0.0'}
      </Text>
    </ScrollView>
  );
}
