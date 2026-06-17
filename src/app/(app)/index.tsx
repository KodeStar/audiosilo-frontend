import { ScrollView } from 'react-native';

import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

// Placeholder Home. Real "Continue listening / Downloaded / Recently finished"
// sections are wired up once the API client and progress sync land.
export default function HomeScreen() {
  return (
    <ScrollView className="flex-1" contentContainerClassName="p-4 gap-6">
      <Text variant="heading">Continue listening</Text>
      <Card>
        <Text>Connect to a server and start a book to see it here.</Text>
      </Card>

      <Text variant="heading">Recently finished</Text>
      <Card>
        <Text variant="muted">Nothing yet.</Text>
      </Card>
    </ScrollView>
  );
}
