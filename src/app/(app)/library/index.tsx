import { Link } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import { useLibraries } from '@/api/hooks';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { libraryHref } from '@/lib/paths';
import { colors } from '@/theme/tokens';

export default function LibrariesScreen() {
  const { data: libraries, isLoading, error, refetch } = useLibraries();

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-3 p-4">
      <Text variant="heading" className="mb-1">
        Libraries
      </Text>

      {isLoading ? <Spinner center /> : null}
      {error ? <ErrorNote message="Could not load libraries." onRetry={() => refetch()} /> : null}

      {libraries?.map((lib) => (
        <Link key={lib.id} href={libraryHref(lib.id)} asChild>
          <Pressable>
            <Card className="flex-row items-center gap-3">
              <Icon name="folder" size={22} color={colors.primary} />
              <View className="flex-1">
                <Text variant="subtitle">{lib.name}</Text>
                <Text variant="muted">
                  {lib.default_view} · {lib.layout}
                </Text>
              </View>
              <Icon name="chevron-right" size={16} />
            </Card>
          </Pressable>
        </Link>
      ))}

      {libraries?.length === 0 ? (
        <EmptyNote message="No libraries are shared with your account yet." />
      ) : null}
    </ScrollView>
  );
}
