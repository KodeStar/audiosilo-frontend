import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  useCapabilitiesAll,
  useCapability,
  useListeningGoal,
  useMyListening,
  useMyStats,
  useServerInfo,
} from '@/api/hooks';
import { listeningStreak, serverToday } from '@/components/home/listening';
import { useSession } from '@/stores/session';

import { type CardCopy, cardCopy, type CopyContext } from './year-copy';
import { buildYearCards, type YearCard } from './year-model';

/** The year a story is for: this year (`year`, the server's own) or a past `YYYY`. */
export type YearRange = 'year' | `${number}`;

export type YearStory =
  | { status: 'loading'; serverName: string }
  | { status: 'unsupported'; serverName: string }
  | { status: 'error'; serverName: string; retry: () => void }
  | { status: 'empty'; serverName: string; year: string; current: boolean }
  | {
      status: 'ready';
      serverName: string;
      year: string;
      current: boolean;
      cards: YearCard[];
      copies: CardCopy[];
    };

/**
 * The story of one year on one server (STYLEGUIDE section 8, "Year in listening"), from
 * the listener's own stats in that server's time: `/me/stats` for the year, plus, for
 * this year, the streak running today (`/me/listening?range=1y`, the cache Home's This
 * week card reads) and the goal (`/me/goal`). A server without `user_stats` is
 * `unsupported` (never an error), one whose `/server` doesn't answer is an `error`, and a
 * year with too little listening is `empty`.
 */
export function useYearStory(cid: string, range: YearRange): YearStory {
  const { t } = useTranslation();
  const info = useServerInfo(cid);
  const supported = useCapability('user_stats', cid);
  const current = range === 'year';
  const stats = useMyStats(range, cid);
  const listening = useMyListening('1y', cid);
  const goal = useListeningGoal(cid);
  const connection = useSession((s) => s.connections.find((c) => c.id === cid));
  const serverName = connection?.name || info.data?.name || '';
  const userName = connection?.user?.username;

  // This year's streak and goal are part of the story: wait for them (unless they fail).
  const extrasPending =
    current && ((!listening.data && !listening.isError) || (!goal.data && !goal.isError));

  const built = useMemo(() => {
    if (!stats.data || extrasPending) return null;
    const year = stats.data.range;
    const today = current && listening.data ? serverToday(listening.data) : null;
    const cards = buildYearCards({
      stats: stats.data,
      current,
      currentStreak: today && listening.data ? listeningStreak(listening.data.days, today) : null,
      goal: current ? (goal.data?.goal?.books_per_year ?? null) : null,
    });
    const ctx: CopyContext = { year, userName, serverName };
    return { year, cards, copies: cards.map((c) => cardCopy(c, ctx, t)) };
  }, [stats.data, extrasPending, current, listening.data, goal.data, userName, serverName, t]);

  if (supported === false) return { status: 'unsupported', serverName };
  if (supported === undefined) {
    return info.isError
      ? { status: 'error', serverName, retry: () => void info.refetch() }
      : { status: 'loading', serverName };
  }
  if (stats.isError && !stats.data) {
    return { status: 'error', serverName, retry: () => void stats.refetch() };
  }
  if (!built) return { status: 'loading', serverName };
  if (built.cards.length === 0) {
    return { status: 'empty', serverName, year: built.year, current };
  }
  return { status: 'ready', serverName, current, ...built };
}

/** The signed-in servers that keep listening stats, in the listener's order, for the
 * server picker (shown only with more than one). */
export function useStatsServers(): { id: string; name: string }[] {
  const caps = useCapabilitiesAll();
  const connections = useSession((s) => s.connections);
  return useMemo(
    () =>
      connections.filter((c) => caps[c.id]?.user_stats).map((c) => ({ id: c.id, name: c.name })),
    [connections, caps],
  );
}
