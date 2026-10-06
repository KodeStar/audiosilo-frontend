import { skipToken, useQueries } from '@tanstack/react-query';

import { nextBookQuery, useCapabilitiesAll } from '@/api/hooks';
import { useApiRegistry } from '@/api/provider';
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
  const { clients } = useApiRegistry();
  const caps = useCapabilitiesAll();
  const flag = (cid: string) => caps[cid]?.next_book;
  const answers = useQueries({
    queries: candidates.map((c) => {
      const spec = nextBookQuery(c.connectionId, clients.get(c.connectionId), c.libraryId, c.path);
      return flag(c.connectionId) ? spec : { ...spec, queryFn: skipToken };
    }),
  });
  const known = [...new Set(candidates.map((c) => c.connectionId))].filter((cid) => caps[cid]);
  return {
    answers: candidates.map((candidate, i) => ({
      candidate,
      answer: answers[i]?.data as NextBook | undefined,
    })),
    supported: known.length === 0 ? undefined : known.some((cid) => !!flag(cid)),
    isLoading: answers.some((a, i) => a.isLoading && !!flag(candidates[i].connectionId)),
  };
}
