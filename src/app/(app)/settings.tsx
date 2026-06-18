import { Pressable, ScrollView, View } from 'react-native';

import { useOptionalApi } from '@/api/provider';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { useSession } from '@/stores/session';
import { useTheme, type SchemePref } from '@/theme/theme-provider';

const APPEARANCE: { value: SchemePref; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export default function SettingsScreen() {
  const { pref, setPref } = useTheme();
  const api = useOptionalApi();
  const user = useSession((s) => s.user);
  const serverUrl = useSession((s) => s.serverUrl);
  const logout = useSession((s) => s.logout);

  const onLogout = async () => {
    // Best-effort server-side revocation; clear locally regardless.
    try {
      await api?.logout();
    } catch {
      // ignore network/4xx; the local session is cleared below
    }
    await logout();
  };

  return (
    <ScrollView className="flex-1" contentContainerClassName="p-4 gap-6">
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
    </ScrollView>
  );
}
