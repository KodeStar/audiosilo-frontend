import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useBridgeEstimate } from '@/api/hooks';
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
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { formatDuration, formatUsd } from '@/lib/format';
import { pathLeaf } from '@/lib/paths';

import { blockedReason, bridgeRefusalKey, queueOrder, runEstimate } from './bridge-model';
import type { GenerateModel } from './use-generate';

/**
 * The confirmation before generating (Bridge Phase 1a): what the Bridge will read (the
 * ebook beside the audio, else the audio), the transcription time and the expected agent
 * cost of every run the button queues (or "no estimate yet"; a subscription's note), where
 * the results appear (always on this server: the player never offers to contribute them),
 * and, when earlier books of the series have no recaps, a switch to queue those first (on
 * by default). Generate is held back, with the reason (`blockedReason`), while the Bridge
 * can't write the library, the book's chapters are still being found or its characters and
 * recaps are being shared (the estimate's `open_job`), or its agent is known not to be
 * ready. The estimate is read afresh each time it opens, again on Retry after a failure,
 * while a share holds Generate back (so the hold lifts once it ends) and after a refused
 * queue (`useBridgeEstimate`).
 */
export function GenerateDialog({ model, title }: { model: GenerateModel; title?: string }) {
  return (
    <Dialog open={model.confirming} onOpenChange={model.setConfirming}>
      {model.confirming ? <GenerateBody model={model} title={title} /> : null}
    </Dialog>
  );
}

function GenerateBody({ model, title }: { model: GenerateModel; title?: string }) {
  const { t } = useTranslation();
  const { connectionId, libraryId, path } = model.target;
  const estimate = useBridgeEstimate(libraryId, path, connectionId);
  const [withEarlier, setWithEarlier] = useState(true);
  const data = estimate.data;
  const earlier = data?.earlier ?? [];
  const blocked = data ? blockedReason(data) : null;
  const books = queueOrder({ library_id: libraryId, path }, earlier, withEarlier);
  // The figures quote every run the button queues (this book and the earlier ones).
  const run = data ? runEstimate(data, withEarlier) : undefined;
  const about = (value: string) =>
    run && run.books > 1
      ? t('bridge.generate.forBooks', {
          count: run.books,
          value: t('bridge.generate.about', { value }),
        })
      : t('bridge.generate.about', { value });

  const confirm = async () => {
    if (await model.queue(books)) model.setConfirming(false);
  };

  return (
    <DialogContent>
      <View className="flex-row items-start gap-3.5">
        <DialogIcon name="sparkles" />
        <DialogHeader className="flex-1">
          <DialogTitle>{t('bridge.generate.title')}</DialogTitle>
          <DialogDescription>
            {title ? t('bridge.generate.lead', { title }) : t('bridge.generate.leadUntitled')}
          </DialogDescription>
        </DialogHeader>
      </View>

      {data ? (
        <View testID="generate-estimate" className="gap-3">
          <Fact
            label={t('bridge.generate.source')}
            value={
              data.source === 'ebook'
                ? t('bridge.generate.sourceEbook', { file: pathLeaf(data.ebook ?? '') })
                : t('bridge.generate.sourceAudio')
            }
          />
          <Fact
            label={t('bridge.generate.transcription')}
            value={
              run?.asrHours === 0
                ? t('bridge.generate.noTranscription')
                : typeof run?.asrHours === 'number'
                  ? about(formatDuration(run.asrHours * 3600))
                  : t('bridge.generate.noEstimate')
            }
          />
          <Fact
            label={t('bridge.generate.cost')}
            value={
              typeof run?.costUsd === 'number'
                ? about(formatUsd(run.costUsd))
                : t('bridge.generate.noEstimate')
            }
            note={data.subscription ? t('bridge.generate.subscription') : undefined}
          />
          <Fact label={t('bridge.generate.results')} value={t('bridge.generate.onThisServer')} />
          {earlier.length > 0 ? (
            <View className="flex-row items-center gap-3 rounded-xl bg-muted p-3">
              <View className="min-w-0 flex-1 gap-0.5">
                <Text variant="label">
                  {t('bridge.generate.earlier', { count: earlier.length })}
                </Text>
                <Text variant="caption" numberOfLines={3}>
                  {earlier.map((b) => b.title || b.path).join(', ')}
                </Text>
              </View>
              <Switch
                testID="generate-earlier"
                checked={withEarlier}
                onCheckedChange={setWithEarlier}
                accessibilityLabel={t('bridge.generate.earlier', { count: earlier.length })}
              />
            </View>
          ) : null}
          {blocked ? (
            <Text testID="generate-blocked" variant="muted" className="text-warning">
              {t(blocked)}
            </Text>
          ) : null}
        </View>
      ) : estimate.isError ? (
        // No automatic retry (`useBridgeEstimate`): the admin asks again from here.
        <View testID="generate-estimate-failed">
          <ErrorNote
            message={t(bridgeRefusalKey(estimate.error, 'bridge.generate.estimateFailed'))}
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
          testID="generate-confirm"
          title={
            books.length > 1
              ? t('bridge.generate.confirmMany', { count: books.length })
              : t('bridge.generate.confirm')
          }
          icon="sparkles"
          disabled={!data || !!blocked}
          loading={model.queueing}
          onPress={() => void confirm()}
        />
      </DialogFooter>
    </DialogContent>
  );
}

/** One line of a Bridge job's estimate (Generate's, Make read-along's): what, then its
 * value and an optional quiet note. */
export function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View className="gap-0.5">
      <Text variant="eyebrow">{label}</Text>
      <Text variant="body">{value}</Text>
      {note ? <Text variant="caption">{note}</Text> : null}
    </View>
  );
}
