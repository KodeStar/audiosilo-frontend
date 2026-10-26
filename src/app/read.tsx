import { useLocalSearchParams } from 'expo-router';

import { useRouteConnection } from '@/components/layout/content-scope';
import { segmentsToPath } from '@/lib/paths';
import { ReaderScreen } from '@/reader/reader-screen';

/**
 * The ebook reader (Bridge Phase 3b, `/read`), a root modal like the player, so it carries the
 * connection as a param (`readerHref`). Thin: it reads the params and hands off to
 * <ReaderScreen>, unless the route-connection rule shows its gate (`useRouteConnection`:
 * an unknown connection, another person's book).
 */
export default function ReaderRoute() {
  const {
    connection,
    libraryId: libParam,
    path: pathParam,
  } = useLocalSearchParams<{ connection?: string; libraryId?: string; path?: string | string[] }>();
  const { cid, gate } = useRouteConnection(connection);
  if (gate) return gate;
  return (
    <ReaderScreen
      connectionId={cid}
      libraryId={Number(libParam)}
      path={segmentsToPath(pathParam)}
    />
  );
}
