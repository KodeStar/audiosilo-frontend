import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiErrorKind } from '@/api/client';
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
 * `useGenerate`). */
export type GenerateModel = {
  target: GenerateTarget;
  /** This person may generate here (`mayGenerate`). Nothing renders without it. */
  allowed: boolean;
  /** What the book offers now (`generateOffer`). */
  offer: 'generate' | 'regenerate' | null;
  /** The job the status shows (`statusJob`): open, or failed. */
  job: BridgeJob | undefined;
  /** The confirmation is open. */
  confirming: boolean;
  setConfirming: (open: boolean) => void;
  /** Queue `books` in order (the confirmation's choice); false when nothing could be. */
  queue: (books: readonly BookRef[]) => Promise<boolean>;
  queueing: boolean;
  cancel: () => void;
  cancelling: boolean;
  /** Queue this book again after a failure. */
  retry: () => void;
};

/**
 * The player's "Generate characters and recaps" for one book (Bridge Phase 1a): who may
 * (`mayGenerate`: an admin, the Bridge online with `sidecars`, `metadata` on), the book's
 * jobs (polled while one is open and `active`), what it offers, and the writes. `content`
 * is the book's characters and recaps as the surface renders them (community or
 * generated); `metaKnown` says its `/meta` answer is in, so nothing is offered for a book
 * whose metadata is still on its way. The jobs are never asked for someone who may not
 * generate (a non-admin would get a 403).
 */
export function useGenerate({
  target,
  content,
  metaKnown,
  active,
  metaPaths,
}: {
  target: GenerateTarget;
  content: GenerateContent | undefined;
  metaKnown: boolean;
  /** The surface is on screen: only then do the jobs poll. */
  active: boolean;
  /** The paths the surface reads `/meta` under (see `useBridgeJobs`). */
  metaPaths?: readonly string[];
}): GenerateModel {
  const { t } = useTranslation();
  const { connectionId, libraryId, path } = target;
  const user = useSession((s) => s.connections.find((c) => c.id === connectionId)?.user);
  const server = useServerInfo(connectionId).data;
  const allowed = mayGenerate(user, server);
  const jobs = useBridgeJobs(
    libraryId,
    path,
    { enabled: allowed, active, metaPaths },
    connectionId,
  );
  const queueJob = useQueueBridgeJob(connectionId);
  const cancelJob = useCancelBridgeJob(connectionId);
  const [confirming, setConfirming] = useState(false);
  const [queueing, setQueueing] = useState(false);

  const job = statusJob(jobs.data);
  const offer = generateOffer({
    allowed,
    metaKnown,
    jobsKnown: jobs.isSuccess,
    job,
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
      if (!(error instanceof CapabilityError)) toast({ title: t(queueFailedKey(error)) });
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
    offer,
    job,
    confirming,
    setConfirming,
    queue,
    queueing,
    cancel: () => {
      if (!job) return;
      cancelJob.mutate(job, {
        onError: (e) => {
          if (!(e instanceof CapabilityError)) toast({ title: t('bridge.status.cancelFailed') });
        },
      });
    },
    cancelling: cancelJob.isPending,
    retry: () => void queue([{ library_id: libraryId, path }]),
  };
}

/** A refusal to queue, in the app's words (never the server's). */
function queueFailedKey(e: unknown) {
  switch (apiErrorKind(e)) {
    case 'library_not_writable':
      return 'bridge.generate.notWritable' as const;
    case 'kind_unavailable':
      return 'bridge.generate.unavailable' as const;
    default:
      return 'bridge.generate.queueFailed' as const;
  }
}
