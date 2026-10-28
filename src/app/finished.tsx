import { useRouteConnection } from '@/components/layout/content-scope';
import { EndCredits } from '@/components/player/end-credits';
import { segmentsToPath } from '@/lib/paths';
import { useRouteParams } from '@/lib/route-params';

/**
 * The end-credits ("book finished") screen, a root modal like the player (so it sits
 * outside any route scope and carries the connection as a param). Thin: it reads the
 * params and hands off to <EndCredits>, which owns the UI + the auto-play countdown, unless
 * the route-connection rule shows its gate (`useRouteConnection`: an unknown connection,
 * another person's book).
 */
export default function FinishedScreen() {
  const {
    connection,
    libraryId: libParam,
    path: pathParam,
    auto,
  } = useRouteParams<{
    connection?: string;
    libraryId?: string;
    path?: string | string[];
    auto?: string;
  }>();
  const libraryId = Number(libParam);
  const path = segmentsToPath(pathParam);
  const { cid, gate } = useRouteConnection(connection);
  if (gate) return gate;

  return <EndCredits connectionId={cid} libraryId={libraryId} path={path} ended={auto === '1'} />;
}
