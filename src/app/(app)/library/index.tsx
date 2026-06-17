import { ScrollView } from 'react-native';

import { BreadCrumbs } from '@/components/ui/breadcrumbs';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

// Placeholder Library. Real filesystem browsing (libraries list + /fs entries
// with covers and breadcrumbs) lands with the API client.
export default function LibraryScreen() {
  return (
    <ScrollView className="flex-1" contentContainerClassName="p-4">
      <BreadCrumbs crumbs={[{ label: 'Library', active: true }]} />
      <Card>
        <Text variant="muted">No libraries yet — connect to a server first.</Text>
      </Card>
    </ScrollView>
  );
}
