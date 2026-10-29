import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { CapabilityError, useBridgeJobs, useCancelBridgeJob, useQueueBridgeJob } from '@/api/hooks';
import type { BridgeJob } from '@/api/types';
import { toast } from '@/components/ui/toast';

import type { GenerateTarget } from './use-generate';

/**
 * What every player surface that queues a Bridge job for one book shares (Generate, Make
 * read-along): whether a job shows its status (`showsJob`, the job list's only read here:
 * the status's own read polls), the confirmation (closed with the permission), the queue
 * mutation and its busy flag, and Cancel. The jobs are never asked for someone who may not
 * (`allowed`: a non-admin would get a 403).
 */
export function useBridgeJobSurface(
  target: GenerateTarget,
  allowed: boolean,
  showsJob: (jobs: BridgeJob[]) => boolean,
) {
  const { t } = useTranslation();
  const { connectionId, libraryId, path } = target;
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
  // The confirmation goes with the permission (the Bridge went offline, the flag is off):
  // its button could send nothing, and it must not open again by itself later.
  if (confirming && !allowed) setConfirming(false);

  return {
    // An answer is in (a later read that failed keeps it: the list has `retry: false`, and
    // its error state alone must not take the button away).
    jobsKnown: jobs.data !== undefined,
    showsJob: jobs.data === true,
    queueJob,
    confirming: confirming && allowed,
    setConfirming,
    queueing,
    setQueueing,
    cancel: (job: BridgeJob) =>
      cancelJob.mutate(job, {
        onError: (e) => {
          // A 409: the job already ended (code `finished`); the list read again on the
          // refusal (`useCancelBridgeJob`) shows how, and trying again can't help.
          if (e instanceof CapabilityError || (e instanceof ApiError && e.status === 409)) return;
          toast({ title: t('bridge.status.cancelFailed') });
        },
      }),
    cancelling: cancelJob.isPending,
  };
}
