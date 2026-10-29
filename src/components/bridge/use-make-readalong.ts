import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import {
  CapabilityError,
  useBridgeJobs,
  useCancelBridgeJob,
  useQueueBridgeJob,
  useServerInfo,
} from '@/api/hooks';
import type { BridgeJob } from '@/api/types';
import { toast } from '@/components/ui/toast';
import { READALONG_ALIGN } from '@/lib/bridge-jobs';
import { mayMakeReadalong } from '@/reader/readalong-gating';
import { useSession } from '@/stores/session';

import type { JobStatusModel } from './generate-status';
import { readalongOffer, readalongRefusalKey, readalongStatusJob } from './readalong-model';
import type { GenerateTarget } from './use-generate';

/** Everything a surface needs to offer "Make read-along" for one book (see
 * `useMakeReadalong`). The job's status is `BridgeJobStatus`'s own read of the job list. */
export type MakeReadalongModel = JobStatusModel & {
  /** "Make read-along" shows now (`readalongOffer`). */
  offer: boolean;
  /** The confirmation is open (never while `allowed` is off: it closes with it). */
  confirming: boolean;
  setConfirming: (open: boolean) => void;
  /** Queue the job: true once queued, false (the confirmation stays open) when it could
   * not be. */
  queue: () => Promise<boolean>;
};

/** Whether a book's job list has a read-along job whose status shows: all the offer reads
 * of it, so a poll that only moves a job's progress re-renders nobody but the status. */
const showsJob = (jobs: BridgeJob[]) => readalongStatusJob(jobs) !== undefined;

/**
 * The player's "Make read-along" for one book (Bridge Phase 3c): who may
 * (`mayMakeReadalong`: an admin, the Bridge online with `readalong`, a server that serves
 * maps), whether it is offered (`readalongOffer`; `hasEbook`: the book has one), and the
 * writes (`readalong.align`, params `{}`). The jobs are never asked for someone who may not
 * (a non-admin would get a 403). A finished job reads the book and its map again
 * (`useBridgeJobs`' `refreshAfterFinish`), so the text takes the offer's place.
 */
export function useMakeReadalong({
  target,
  hasEbook,
}: {
  target: GenerateTarget;
  hasEbook: boolean;
}): MakeReadalongModel {
  const { t } = useTranslation();
  const { connectionId, libraryId, path } = target;
  const user = useSession((s) => s.connections.find((c) => c.id === connectionId)?.user);
  const server = useServerInfo(connectionId).data;
  const allowed = mayMakeReadalong(user, server);
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
  if (confirming && !allowed) setConfirming(false);

  const queue = async () => {
    setQueueing(true);
    try {
      await queueJob.mutateAsync({
        kind: READALONG_ALIGN,
        library_id: libraryId,
        path,
        params: {},
      });
      toast({ title: t('bridge.readalong.queued') });
      return true;
    } catch (e) {
      // A CapabilityError was never sent (the Bridge went offline meanwhile): the offer
      // goes with the flag, so there is nothing to say.
      if (!(e instanceof CapabilityError)) {
        toast({ title: t(readalongRefusalKey(e, 'bridge.readalong.queueFailed')) });
      }
      return false;
    } finally {
      setQueueing(false);
    }
  };

  return {
    target,
    allowed,
    offer: readalongOffer({
      allowed,
      hasEbook,
      jobsKnown: jobs.data !== undefined,
      showsJob: jobs.data === true,
    }),
    confirming: confirming && allowed,
    setConfirming,
    queue,
    queueing,
    cancel: (job) =>
      cancelJob.mutate(job, {
        onError: (e) => {
          // A 409: the job already ended; the list read again shows how.
          if (e instanceof CapabilityError || (e instanceof ApiError && e.status === 409)) return;
          toast({ title: t('bridge.status.cancelFailed') });
        },
      }),
    cancelling: cancelJob.isPending,
    retry: () => void queue(),
  };
}
