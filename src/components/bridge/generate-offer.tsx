import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';

import type { GenerateContent } from './bridge-model';
import { GenerateDialog } from './generate-dialog';
import { GenerateStatus } from './generate-status';
import { type GenerateTarget, useGenerate } from './use-generate';

/**
 * "Generate characters and recaps" under an empty state (the companion's Who's who and
 * Story so far, for a book with neither): the button for an admin who may (`mayGenerate`),
 * the job's status in its place while one runs or after it failed, nothing for anyone
 * else. Mounted only while the empty state shows, so its jobs poll only then.
 */
export function GenerateOffer({
  target,
  content,
  metaKnown,
  title,
}: {
  target: GenerateTarget;
  content: GenerateContent | undefined;
  metaKnown: boolean;
  title?: string;
}) {
  const { t } = useTranslation();
  const model = useGenerate({ target, content, metaKnown, active: true });
  if (!model.allowed) return null;
  return (
    <View className="items-center px-6">
      {model.job ? (
        <GenerateStatus
          job={model.job}
          onCancel={model.cancel}
          cancelling={model.cancelling}
          onRetry={model.retry}
          retrying={model.queueing}
          className="w-full"
        />
      ) : model.offer === 'generate' ? (
        <Button
          testID="generate-action"
          variant="secondary"
          icon="sparkles"
          title={t('bridge.generate.action')}
          onPress={() => model.setConfirming(true)}
        />
      ) : null}
      <GenerateDialog model={model} title={title} />
    </View>
  );
}
