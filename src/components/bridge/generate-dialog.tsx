import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { apiErrorKind } from '@/api/client';
import { useBridgeEstimate } from '@/api/hooks';
import type { BridgeEstimate } from '@/api/types';
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
import { SkeletonText } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { SIDECARS_GENERATE } from '@/lib/bridge-jobs';
import { formatDuration } from '@/lib/format';

import { formatUsd, queueOrder } from './bridge-model';
import type { GenerateModel } from './use-generate';

/**
 * The confirmation before generating (Bridge Phase 1a): what the Bridge will read (the
 * ebook beside the audio, else the audio), the transcription time, the expected agent cost
 * (or "no estimate yet"; a subscription's note), where the results appear (always on this
 * server: the player never offers to contribute them), and, when earlier books of the
 * series have no recaps, a switch to queue those first (on by default). Generate is held
 * back, with the reason, while the Bridge can't write the library or its agent isn't
 * ready. The estimate is read afresh each time it opens.
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
  const estimate = useBridgeEstimate(libraryId, path, SIDECARS_GENERATE, true, connectionId);
  const [withEarlier, setWithEarlier] = useState(true);
  const data = estimate.data;
  const earlier = data?.earlier ?? [];
  const blocked = data ? blockedReason(data) : null;
  const books = queueOrder({ library_id: libraryId, path }, earlier, withEarlier);

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
                ? t('bridge.generate.sourceEbook', { file: fileName(data.ebook) })
                : t('bridge.generate.sourceAudio')
            }
          />
          <Fact
            label={t('bridge.generate.transcription')}
            value={
              data.source === 'ebook' || !(data.asr_hours > 0)
                ? t('bridge.generate.noTranscription')
                : t('bridge.generate.about', { value: formatDuration(data.asr_hours * 3600) })
            }
          />
          <Fact
            label={t('bridge.generate.cost')}
            value={
              typeof data.agent_cost_usd === 'number'
                ? t('bridge.generate.about', { value: formatUsd(data.agent_cost_usd) })
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
        <Text testID="generate-estimate-failed" variant="muted">
          {apiErrorKind(estimate.error) === 'kind_unavailable'
            ? t('bridge.generate.unavailable')
            : t('bridge.generate.estimateFailed')}
        </Text>
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

/** Why Generate is held back, when it is: the Bridge can't write the library (its
 * results would have nowhere to go), or its agent isn't signed in. */
function blockedReason(e: BridgeEstimate) {
  if (!e.writable) return 'bridge.generate.notWritable' as const;
  if (!e.agent_ready) return 'bridge.generate.agentNotReady' as const;
  return null;
}

/** The last segment of a path ("Book.epub"). */
function fileName(path: string | undefined): string {
  return path?.split('/').pop() ?? '';
}

/** One line of the estimate: what, then its value and an optional quiet note. */
function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View className="gap-0.5">
      <Text variant="eyebrow">{label}</Text>
      <Text variant="body">{value}</Text>
      {note ? <Text variant="caption">{note}</Text> : null}
    </View>
  );
}
