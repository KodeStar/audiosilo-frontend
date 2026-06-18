import Constants from 'expo-constants';
import { Pressable, ScrollView, View } from 'react-native';

import { useOptionalApi } from '@/api/provider';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import { useTheme, type SchemePref } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

const APPEARANCE: { value: SchemePref; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

const RATES = [0.8, 1, 1.25, 1.5, 1.75, 2];

function Stepper({
  value,
  onChange,
  step = 5,
  min = 5,
  max = 120,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <Pressable
        onPress={() => onChange(Math.max(min, value - step))}
        className="h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-860"
      >
        <Icon name="minus" size={14} color={colors.primary} />
      </Pressable>
      <Text variant="subtitle" className="w-12 text-center">
        {value}s
      </Text>
      <Pressable
        onPress={() => onChange(Math.min(max, value + step))}
        className="h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-860"
      >
        <Icon name="plus" size={14} color={colors.primary} />
      </Pressable>
    </View>
  );
}

export default function SettingsScreen() {
  const { pref, setPref } = useTheme();
  const api = useOptionalApi();
  const user = useSession((s) => s.user);
  const serverUrl = useSession((s) => s.serverUrl);
  const logout = useSession((s) => s.logout);

  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const defaultRate = useSettings((s) => s.defaultRate);
  const setSkipForward = useSettings((s) => s.setSkipForward);
  const setSkipBackward = useSettings((s) => s.setSkipBackward);
  const setDefaultRate = useSettings((s) => s.setDefaultRate);

  const onLogout = async () => {
    try {
      await api?.logout();
    } catch {
      // ignore; clear locally regardless
    }
    await logout();
  };

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-6 p-4">
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
            <Stepper value={skipBackward} onChange={setSkipBackward} />
          </View>
          <View className="flex-row items-center justify-between">
            <Text>Skip forward</Text>
            <Stepper value={skipForward} onChange={setSkipForward} />
          </View>
          <View className="gap-2">
            <Text>Default speed</Text>
            <View className="flex-row flex-wrap gap-2">
              {RATES.map((r) => {
                const active = defaultRate === r;
                return (
                  <Pressable
                    key={r}
                    onPress={() => setDefaultRate(r)}
                    className={`rounded-full px-3 py-1.5 ${active ? 'bg-primary' : 'bg-gray-100 dark:bg-gray-860'}`}
                  >
                    <Text
                      className={`text-sm ${active ? 'text-white dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}
                    >
                      {r}×
                    </Text>
                  </Pressable>
                );
              })}
            </View>
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

      <Text variant="caption" className="text-center">
        AudioSilo v{Constants.expoConfig?.version ?? '1.0.0'}
      </Text>
    </ScrollView>
  );
}
