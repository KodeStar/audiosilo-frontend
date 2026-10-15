import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CapabilityError,
  useBridgeJobs,
  useCancelBridgeJob,
  useQueueBridgeJob,
  useServerInfo,
} from '@/api/hooks';
import type { BookRef, BridgeJob } from '@/api/types';
import { toast } from '@/components/ui/toast';
import { SIDECARS_GENERATE } from '@/lib/bridge-jobs';
import { useSession } from '@/stores/session';

import {
  bridgeRefusalKey,
  GENERATE_PARAMS,
  type GenerateContent,
  generateOffer,
  mayGenerate,
  queueInOrder,
  statusJob,
} from './bridge-model';

export type GenerateTarget = {
  connectionId: string;
  libraryId: number;
  /** The book's own path (`rel_path`): jobs are queued and listed by it. */
  path: string;
};

/** Everything a surface needs to offer "Generate characters and recaps" for one book (see
 * `useGenerate`). The job's status is `GenerateStatus`'s own read of the job list. */
export type GenerateModel = {
  target: GenerateTarget;
  /** This person may generate here (`mayGenerate`). Nothing renders without it. */
  allowed: boolean;
  /** The surface is on screen: the status's job list polls only then. */
  active: boolean;
  /** What the book offers now (`generateOffer`). */
  offer: 'generate' | 'regenerate' | null;
  /** The confirmation is open. */
  confirming: boolean;
  setConfirming: (open: boolean) => void;
  /** Queue `books` in order (the confirmation's choice); false when nothing could be. */
  queue: (books: readonly BookRef[]) => Promise<boolean>;
  queueing: boolean;
  cancel: (job: BridgeJob) => void;
  cancelling: boolean;
  /** Queue this book again after a failure. */
  retry: () => void;
};

/** Whether a book's job list has a job whose status shows (`statusJob`): all the offer
 * reads of it, so a poll that only moves a job's progress re-renders nobody but the
 * status. */
const showsJob = (jobs: BridgeJob[]) => statusJob(jobs) !== undefined;

/**
 * The player's "Generate characters and recaps" for one book (Bridge Phase 1a): who may
 * (`mayGenerate`: an admin, the Bridge online with `sidecars`, `metadata` on), what the
 * book offers, and the writes. `content` is the book's characters and recaps as the
 * surface renders them (community or generated); `metaKnown` says its `/meta` answer is
 * in (or that none is asked for), so nothing is offered for a book whose metadata is
 * still on its way. The jobs are never asked for someone who may not generate (a
 * non-admin would get a 403); the job's status renders from `GenerateStatus`.
 */
export function useGenerate({
  target,
  content,
  metaKnown,
  active,
}: {
  target: GenerateTarget;
  content: GenerateContent | undefined;
  metaKnown: boolean;
  /** The surface is on screen: only then do the jobs poll. */
  active: boolean;
}): GenerateModel {
  const { t } = useTranslation();
  const { connectionId, libraryId, path } = target;
  const user = useSession((s) => s.connections.find((c) => c.id === connectionId)?.user);
  const server = useServerInfo(connectionId).data;
  const allowed = mayGenerate(user, server);
  // The status's own read polls; this one only says whether a job shows.
  const jobs = useBridgeJobs(
    libraryId,
    path,
    { enabled: allowed, active: false, select: showsJob },
    connectionId,
  );
  const queueJob = useQueueBridgeJob(connectionId);
  const cancelJob = useCancelBridgeJob(connectionId);
  const [confirming, setConfirming] = useState(false);
  const [queueing, setQueueing] = useState(false);

  const offer = generateOffer({
    allowed,
    metaKnown,
    jobsKnown: jobs.isSuccess,
    showsJob: jobs.data === true,
    content,
  });

  const queue = async (books: readonly BookRef[]) => {
    setQueueing(true);
    const { queued, error } = await queueInOrder(books, (book) =>
      queueJob.mutateAsync({ kind: SIDECARS_GENERATE, ...book, params: GENERATE_PARAMS }),
    );
    setQueueing(false);
    if (queued.length === 0) {
      // A CapabilityError was never sent (the Bridge went offline meanwhile): the button
      // goes with the flag, so there is nothing to say.
      if (!(error instanceof CapabilityError)) {
        toast({ title: t(bridgeRefusalKey(error, 'bridge.generate.queueFailed')) });
      }
      return false;
    }
    toast({
      title:
        error !== undefined
          ? t('bridge.generate.queuedSome', { count: queued.length, total: books.length })
          : queued.length > 1
            ? t('bridge.generate.queuedMany', { count: queued.length })
            : t('bridge.generate.queued'),
    });
    return true;
  };

  return {
    target,
    allowed,
    active,
    offer,
    confirming,
    setConfirming,
    queue,
    queueing,
    cancel: (job) =>
      cancelJob.mutate(job, {
        onError: (e) => {
          if (!(e instanceof CapabilityError)) toast({ title: t('bridge.status.cancelFailed') });
        },
      }),
    cancelling: cancelJob.isPending,
    retry: () => void queue([{ library_id: libraryId, path }]),
  };
}
