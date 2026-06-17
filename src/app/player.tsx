import { router } from 'expo-router';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

// Placeholder full-screen player (modal). Real transport controls, seek bar,
// speed, and chapter list land with the hybrid PlaybackService.
export default function PlayerScreen() {
  return (
    <View className="flex-1 items-center justify-center gap-6 bg-gray-200 p-6 dark:bg-gray-800">
      <Text variant="heading">Now Playing</Text>
      <Text variant="muted">Nothing is playing yet.</Text>
      <Button title="Close" variant="secondary" icon="close" onPress={() => router.back()} />
    </View>
  );
}
