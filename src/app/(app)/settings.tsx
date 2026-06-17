import { Pressable, ScrollView, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { useTheme, type SchemePref } from '@/theme/theme-provider';

const APPEARANCE: { value: SchemePref; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export default function SettingsScreen() {
  const { pref, setPref } = useTheme();
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
                  className={`font-roboto-medium ${active ? 'text-white' : 'text-gray-600 dark:text-gray-400'}`}
                >
                  {o.label}
                </Text>
              </Pressable>
            );
          })}
        </Card>
      </View>
    </ScrollView>
  );
}
