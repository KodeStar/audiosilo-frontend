import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import { qk } from '@/api/hooks';
import { onForeground } from '@/lib/when-active';

/** Every server's upcoming list: the first segment of `qk.upcoming`. */
const UPCOMING_ALL = qk.upcoming('').slice(0, 1);

/**
 * The time Upcoming's "New" badges count from, read again whenever its screen comes back
 * into focus or the app back to the foreground (a web tab shown again), and not in between,
 * so a list in view keeps its badges steady. A focus also reads the upcoming lists again
 * once stale: a Home left open past a release day would otherwise keep its "Out <date>"
 * until a reload (fe#204), since the app does not refetch on window focus. Coming to the
 * foreground needs no read here: `useAppResume` reads every active query again then.
 */
export function useUpcomingClock(): Date {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => new Date());
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
      // A read already under way (the mount's own) is joined, not restarted.
      void qc.refetchQueries(
        { queryKey: UPCOMING_ALL, type: 'active', stale: true },
        { cancelRefetch: false },
      );
    }, [qc]),
  );
  useEffect(() => onForeground(() => setNow(new Date())), []);
  return now;
}
