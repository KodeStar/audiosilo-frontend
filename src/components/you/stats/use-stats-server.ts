import { useMemo } from 'react';

import { useCapabilitiesAll } from '@/api/hooks';
import { useApis, useCid } from '@/api/provider';

import { statsServerChoice } from './stats-model';

/**
 * Which server's listening Your listening and Year in listening show (`statsServerChoice`):
 * the listener's `picked` one while it keeps stats, else the default connection, else the
 * first that keeps stats; `name` is its name. `choices` are the servers that keep stats,
 * in the listener's order, with their names (a picker shows only with two or more).
 */
export function useStatsServer(picked: string | null): {
  cid: string;
  name: string;
  choices: { id: string; name: string }[];
} {
  const apis = useApis();
  const caps = useCapabilitiesAll();
  const defaultId = useCid();
  return useMemo(() => {
    const ids = apis.map((a) => a.connection.id);
    const { cid, choices } = statsServerChoice({
      connectionIds: ids,
      userStats: Object.fromEntries(
        ids.map((id) => [id, caps[id] ? !!caps[id]?.user_stats : undefined]),
      ),
      defaultId,
      picked,
    });
    const nameOf = (id: string) => apis.find((a) => a.connection.id === id)?.connection.name ?? '';
    return { cid, name: nameOf(cid), choices: choices.map((id) => ({ id, name: nameOf(id) })) };
  }, [apis, caps, defaultId, picked]);
}
