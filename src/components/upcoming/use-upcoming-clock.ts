import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * The time Upcoming's "New" badges count from, read again whenever its screen comes back
 * into focus or the app back to the foreground (a web tab shown again), and not in between,
 * so a list in view keeps its badges steady. Each of those also reads the upcoming lists
 * again once stale: a Home left open past a release day would otherwise keep its "Out
 * <date>" until a reload (fe#204), since the app does not refetch on window focus.
 */
export function useUpcomingClock(): Date {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => new Date());
  const refresh = useCallback(() => {
    setNow(new Date());
    void qc.refetchQueries({ queryKey: ['upcoming'], type: 'active', stale: true });
  }, [qc]);
  useFocusEffect(refresh);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);
  return now;
}
