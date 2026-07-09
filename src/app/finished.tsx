import { useLocalSearchParams } from 'expo-router';

import { EndCredits } from '@/components/player/end-credits';
import { segmentsToPath } from '@/lib/paths';

/**
 * The end-credits ("book finished") screen, a root modal like the player (so it sits
 * outside any route scope and carries the connection as a param). Thin: it reads the
 * params and hands off to <EndCredits>, which owns the UI + the auto-play countdown.
 */
export default function FinishedScreen() {
  const {
    connection: connectionId,
    libraryId: libParam,
    path: pathParam,
  } = useLocalSearchParams<{
    connection?: string;
    libraryId?: string;
    path?: string | string[];
    auto?: string;
  }>();
  const libraryId = Number(libParam);
  const path = segmentsToPath(pathParam);

  return <EndCredits connectionId={connectionId ?? ''} libraryId={libraryId} path={path} />;
}
