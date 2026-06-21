import Constants from 'expo-constants';
import { useState } from 'react';
import { Image, Pressable, ScrollView, Share, View } from 'react-native';

import { ApiError } from '@/api/client';
import { useServerInfo } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import type { PairingPayload } from '@/api/types';
import { SignOutConfirm } from '@/components/account/sign-out-confirm';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Stepper } from '@/components/ui/stepper';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { needsRecoveryWarning } from '@/lib/recovery';
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
  const setUser = useSession((s) => s.setUser);

  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const defaultRate = useSettings((s) => s.defaultRate);
  const autoRewindMax = useSettings((s) => s.autoRewindMax);
  const setSkipForward = useSettings((s) => s.setSkipForward);
  const setSkipBackward = useSettings((s) => s.setSkipBackward);
  const setDefaultRate = useSettings((s) => s.setDefaultRate);
  const setAutoRewindMax = useSettings((s) => s.setAutoRewindMax);

  // Set/change a password — the conventional way back in after a sign-out.
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);

  const savePassword = async () => {
    if (!api) return;
    setPwError(null);
    setPwBusy(true);
    try {
      await api.setPassword(pw);
      setUser(await api.me()); // refresh has_password for the sign-out guard
      setPw('');
      setPwOpen(false);
      setPwDone(true);
    } catch (e) {
      setPwError(e instanceof ApiError ? e.message : 'Could not update the password.');
    } finally {
      setPwBusy(false);
    }
  };

  // Recovery code — a durable secret the user keeps to re-pair without an admin.
  const [recovery, setRecovery] = useState<string | null>(null);
  const [recBusy, setRecBusy] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);

  const generateRecovery = async () => {
    if (!api) return;
    setRecError(null);
    setRecBusy(true);
    try {
      const code = await api.generateRecoveryCode();
      setRecovery(code);
      setUser(await api.me()); // refresh has_recovery for the sign-out guard
    } catch (e) {
      setRecError(e instanceof ApiError ? e.message : 'Could not generate a recovery code.');
    } finally {
      setRecBusy(false);
    }
  };

  const shareRecovery = async () => {
    if (!recovery) return;
    try {
      await Share.share({ message: recovery });
    } catch {
      // user dismissed, or sharing is unavailable on this platform
    }
  };

  // Sign-out, guarded: a user with no durable credential is warned (and offered a
  // recovery code) before their only way in is revoked.
  const [confirmOut, setConfirmOut] = useState(false);
  const doSignOut = async () => {
    setConfirmOut(false);
    try {
      await api?.logout();
    } catch {
      // ignore; clear locally regardless
    }
    await logout();
  };
  const onSignOutPress = () => {
    if (needsRecoveryWarning(user)) setConfirmOut(true);
    else void doSignOut();
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
    <>
      <ScrollView className="flex-1" contentContainerClassName="gap-6 p-4 lg:px-8">
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
          <Card className="gap-4">
            <View>
              <Text variant="subtitle">{user?.username ?? 'Signed in'}</Text>
              <Text variant="muted">
                {user?.role === 'admin' ? 'Administrator' : 'User'}
                {serverUrl ? ` · ${serverUrl.replace(/^https?:\/\//, '')}` : ''}
              </Text>
            </View>

            <View className="gap-2">
              <View className="flex-row items-center justify-between">
                <Text>Password</Text>
                <Text variant="muted">{user?.has_password ? 'Set' : 'Not set'}</Text>
              </View>
              {pwOpen ? (
                <View className="gap-2">
                  <TextField
                    placeholder="New password (min 8 characters)"
                    secureTextEntry
                    autoCapitalize="none"
                    value={pw}
                    onChangeText={setPw}
                    error={pwError ?? undefined}
                  />
                  <View className="flex-row gap-2">
                    <Button title="Save" loading={pwBusy} onPress={savePassword} />
                    <Button
                      title="Cancel"
                      variant="ghost"
                      onPress={() => {
                        setPwOpen(false);
                        setPw('');
                        setPwError(null);
                      }}
                    />
                  </View>
                </View>
              ) : (
                <Button
                  title={user?.has_password ? 'Change password' : 'Set a password'}
                  variant="secondary"
                  onPress={() => {
                    setPwDone(false);
                    setPwOpen(true);
                  }}
                />
              )}
              {pwDone ? (
                <Text variant="muted" className="text-xs">
                  Password updated — you can now sign in with your username and password.
                </Text>
              ) : null}
            </View>

            <View className="gap-2">
              <View className="flex-row items-center justify-between">
                <Text>Recovery code</Text>
                <Text variant="muted">{user?.has_recovery ? 'Set' : 'Not set'}</Text>
              </View>
              {recovery ? (
                <View className="gap-2 rounded-lg bg-gray-100 p-3 dark:bg-gray-860">
                  <Text variant="muted" className="text-xs">
                    Save this somewhere safe. Enter it on the connect screen to sign back in on any
                    device. It won’t be shown again.
                  </Text>
                  <Text
                    selectable
                    className="text-center font-roboto-semibold text-lg tracking-wider"
                  >
                    {recovery}
                  </Text>
                  <View className="flex-row gap-2">
                    <Button
                      title="Share"
                      variant="secondary"
                      icon="qrcode"
                      onPress={shareRecovery}
                    />
                    <Button title="Done" variant="ghost" onPress={() => setRecovery(null)} />
                  </View>
                </View>
              ) : (
                <>
                  <Text variant="muted" className="text-xs">
                    A code you keep to sign back in yourself — no admin needed.
                  </Text>
                  {recError ? <Text className="text-xs text-red-500">{recError}</Text> : null}
                  <Button
                    title={
                      user?.has_recovery ? 'Regenerate recovery code' : 'Generate recovery code'
                    }
                    variant="secondary"
                    icon="qrcode"
                    loading={recBusy}
                    onPress={generateRecovery}
                  />
                </>
              )}
            </View>

            <Button title="Sign out" variant="secondary" icon="logout" onPress={onSignOutPress} />
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
                  <Button
                    title="Share link"
                    variant="secondary"
                    icon="qrcode"
                    onPress={shareLink}
                  />
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

      <SignOutConfirm
        visible={confirmOut}
        onCancel={() => setConfirmOut(false)}
        onSignOut={doSignOut}
        onSetRecovery={() => {
          setConfirmOut(false);
          void generateRecovery();
        }}
      />
    </>
  );
}
