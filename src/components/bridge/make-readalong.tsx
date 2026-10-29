import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useReadalongEstimate } from '@/api/hooks';
import type { ReadalongEstimate } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorNote } from '@/components/ui/query-state';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { pathLeaf } from '@/lib/paths';

import { Fact } from './generate-dialog';
import { BridgeJobStatus } from './generate-status';
import { readalongBlockKey, readalongRefusalKey, readalongStatusJob } from './readalong-model';
import { type MakeReadalongModel, useMakeReadalong } from './use-make-readalong';
import type { GenerateTarget } from './use-generate';

/**
 * "Make read-along" under the companion Text tab's empty state (Bridge Phase 3c, admin
 * only; Generate's pattern): the button for an admin who may (`mayMakeReadalong`), the
 * job's status in its place while one runs or after it failed, nothing for anyone else.
 * Mounted only while the empty state shows, so its jobs poll only then.
 */
export function MakeReadalongOffer({
  target,
  hasEbook,
  title,
  again = false,
}: {
  target: GenerateTarget;
  hasEbook: boolean;
  title?: string;
  /** The book has a map that can't be followed (stale, or not this ebook's): "Make it
   * again". */
  again?: boolean;
}) {
  const { t } = useTranslation();
  const model = useMakeReadalong({ target, hasEbook });
  if (!model.allowed) return null;
  return (
    <View className="items-center px-6">
      <BridgeJobStatus
        model={model}
        select={readalongStatusJob}
        words={{
          title: t('bridge.readalong.statusTitle'),
          parkedTitle: t('bridge.readalong.parkedTitle'),
          failedTitle: t('bridge.readalong.failedTitle'),
          testID: 'readalong',
        }}
        className="w-full"
      />
      {model.offer ? (
        <Button
          testID="readalong-make"
          variant="secondary"
          icon="sparkles"
          title={t(again ? 'bridge.readalong.makeAgain' : 'bridge.readalong.make')}
          onPress={() => model.setConfirming(true)}
        />
      ) : null}
      <MakeReadalongDialog model={model} title={title} />
    </View>
  );
}

/**
 * The confirmation before making a book's read-along: what the Bridge reads (the book's
 * ebook and its audio), the most transcription it may take (less when the Bridge kept the
 * book's transcript), that no AI agent is used, and that the result appears on this server.
 * Make is held back, with the reason (`readalongBlockKey`), for a book without an ebook, a
 * library the Bridge can't write, or an open generate, detect or read-along job. The
 * estimate is read afresh each time it opens.
 */
export function MakeReadalongDialog({
  model,
  title,
}: {
  model: MakeReadalongModel;
  title?: string;
}) {
  return (
    <Dialog open={model.confirming} onOpenChange={model.setConfirming}>
      {model.confirming ? <MakeBody model={model} title={title} /> : null}
    </Dialog>
  );
}

/** The transcription the estimate quotes: up to its hours, none (the Bridge kept the
 * transcript), or no estimate without the Bridge's figures. */
function transcriptionKey(e: Pick<ReadalongEstimate, 'figures' | 'asr_hours'>) {
  if (e.figures !== true || !Number.isFinite(e.asr_hours) || e.asr_hours < 0) {
    return { key: 'bridge.generate.noEstimate' as const };
  }
  if (e.asr_hours === 0) return { key: 'bridge.generate.noTranscription' as const };
  return { key: 'bridge.readalong.upTo' as const, value: formatDuration(e.asr_hours * 3600) };
}

function MakeBody({ model, title }: { model: MakeReadalongModel; title?: string }) {
  const { t } = useTranslation();
  const { connectionId, libraryId, path } = model.target;
  const estimate = useReadalongEstimate(libraryId, path, connectionId);
  const data = estimate.data;
  const blocked = data ? readalongBlockKey(data) : null;
  const transcription = data ? transcriptionKey(data) : null;

  const confirm = async () => {
    if (await model.queue()) model.setConfirming(false);
  };

  return (
    <DialogContent>
      <View className="flex-row items-start gap-3.5">
        <DialogIcon name="sparkles" />
        <DialogHeader className="flex-1">
          <DialogTitle>{t('bridge.readalong.title')}</DialogTitle>
          <DialogDescription>
            {title ? t('bridge.readalong.lead', { title }) : t('bridge.readalong.leadUntitled')}
          </DialogDescription>
        </DialogHeader>
      </View>

      {data ? (
        <View testID="readalong-estimate" className="gap-3">
          <Fact
            label={t('bridge.generate.source')}
            value={
              data.ebook
                ? t('bridge.readalong.sourceBoth', { file: pathLeaf(data.ebook.path) })
                : t('bridge.readalong.sourceAudio')
            }
          />
          {transcription ? (
            <Fact
              label={t('bridge.generate.transcription')}
              value={t(transcription.key, { value: transcription.value })}
            />
          ) : null}
          <Fact label={t('bridge.generate.cost')} value={t('bridge.readalong.noAgent')} />
          <Fact label={t('bridge.generate.results')} value={t('bridge.generate.onThisServer')} />
          {blocked ? (
            <Text testID="readalong-blocked" variant="muted" className="text-warning">
              {t(blocked)}
            </Text>
          ) : null}
        </View>
      ) : estimate.isError ? (
        <View testID="readalong-estimate-failed">
          <ErrorNote
            message={t(readalongRefusalKey(estimate.error, 'bridge.generate.estimateFailed'))}
            onRetry={() => void estimate.refetch()}
          />
        </View>
      ) : (
        <SkeletonText lines={4} className="py-1" />
      )}

      <DialogFooter>
        <Button
          title={t('common.cancel')}
          variant="ghost"
          onPress={() => model.setConfirming(false)}
        />
        <Button
          testID="readalong-confirm"
          title={t('bridge.readalong.confirm')}
          icon="sparkles"
          disabled={!data || !!blocked}
          loading={model.queueing}
          onPress={() => void confirm()}
        />
      </DialogFooter>
    </DialogContent>
  );
}
