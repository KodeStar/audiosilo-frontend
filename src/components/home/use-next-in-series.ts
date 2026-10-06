import { skipToken, useQueries } from '@tanstack/react-query';

import { qk } from '@/api/hooks';
import { useApis } from '@/api/provider';
import type { NextBook } from '@/api/types';

import type { NextCandidate } from './home-model';

/**
 * The server's `/next` answer for each of Home's candidates (`nextCandidates`, a fixed
 * handful), each asked of the candidate's own server and only where that server
 * advertises `next_book` (no query function otherwise, like the gated hooks). Shares
 * `useNextBook`'s cache entries and `useServerInfo`'s. `supported` is undefined while
 * no candidate's server has answered `/server`, then whether any of them can answer.
 */
export function useNextInSeries(candidates: readonly NextCandidate[]) {
  const apis = useApis();
  const clientOf = (cid: string) => apis.find((a) => a.connection.id === cid)?.client ?? null;
  const cids = [...new Set(candidates.map((c) => c.connectionId))];
  const servers = useQueries({
    queries: cids.map((cid) => {
      const client = clientOf(cid);
      return {
        queryKey: qk.server(cid),
        queryFn: client
          ? ({ signal }: { signal: AbortSignal }) => client.serverInfo(signal)
          : skipToken,
        staleTime: 5 * 60_000,
        gcTime: Infinity,
      };
    }),
  });
  const flag = (cid: string) => servers[cids.indexOf(cid)]?.data?.capabilities.next_book;
  const answers = useQueries({
    queries: candidates.map((c) => {
      const client = clientOf(c.connectionId);
      return {
        queryKey: qk.nextBook(c.connectionId, c.libraryId, c.path),
        queryFn:
          client && flag(c.connectionId)
            ? ({ signal }: { signal: AbortSignal }) => client.nextBook(c.libraryId, c.path, signal)
            : skipToken,
      };
    }),
  });
  const known = cids.filter((cid) => servers[cids.indexOf(cid)]?.data);
  return {
    answers: candidates.map((candidate, i) => ({
      candidate,
      answer: answers[i]?.data as NextBook | undefined,
    })),
    supported: known.length === 0 ? undefined : known.some((cid) => !!flag(cid)),
    isLoading: answers.some((a, i) => a.isLoading && !!flag(candidates[i].connectionId)),
  };
}
