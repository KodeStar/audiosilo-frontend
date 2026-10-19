import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';

import type { GenerateContent } from './bridge-model';
import { GenerateCovered } from './generate-covered';
import { GenerateDialog } from './generate-dialog';
import { GenerateStatus } from './generate-status';
import { type GenerateTarget, useGenerate } from './use-generate';

/**
 * "Generate characters and recaps" under an empty state (the companion's Who's who and
 * Story so far, for a book missing either): the button for an admin who may
 * (`mayGenerate`), the job's status in its place while one runs or after it failed,
 * nothing for anyone else. Mounted only while the empty state shows, so its jobs poll only
 * then. The community covering both (`covered`) reads as the line alone, with no link:
 * the companion is already where the characters are (and an empty panel there means the
 * community lacks that half, so it shows only defensively).
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
  const model = useGenerate({ target, content, metaKnown });
  if (!model.allowed) return null;
  return (
    <View className="items-center px-6">
      <GenerateStatus model={model} className="w-full" />
      <GenerateCovered model={model} />
      {model.offer === 'generate' ? (
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
