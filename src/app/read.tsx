import { useLocalSearchParams } from 'expo-router';

import { useCid } from '@/api/provider';
import { useRouteConnection } from '@/components/layout/content-scope';
import { segmentsToPath } from '@/lib/paths';
import { ReaderScreen } from '@/reader/reader-screen';

/**
 * The ebook reader (Bridge Phase 3b, `/read`), a root modal like the player, so it carries the
 * connection as a param (`readerHref`). Thin: it reads the params and hands off to
 * <ReaderScreen>, unless the route-connection rule shows its gate (`useRouteConnection`:
 * an unknown connection, another person's book). A link without `connection=` (a
 * hand-edited or old one) reads through the active connection, as the player does
 * (CONNECT-05).
 */
export default function ReaderRoute() {
  const {
    connection,
    libraryId: libParam,
    path: pathParam,
  } = useLocalSearchParams<{ connection?: string; libraryId?: string; path?: string | string[] }>();
  const { cid: param, gate } = useRouteConnection(connection);
  const cid = useCid(param || undefined);
  if (gate) return gate;
  const libraryId = Number(libParam);
  const path = segmentsToPath(pathParam);
  // A new screen per book: a deep link to another book while /read is open reuses this
  // route (expo-router's NAVIGATE reuses a route of the same name) and changes its params
  // in place, but the screen keeps per-book state (where it opened, the last saved place,
  // `opened`, the failure) and the app's WebView would never say ready again.
  return (
    <ReaderScreen
      key={`${cid}:${libraryId}:${path}`}
      connectionId={cid}
      libraryId={libraryId}
      path={path}
    />
  );
}
