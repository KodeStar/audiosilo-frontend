import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Card } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

import { type FileRow, type PlaybackMode, visibleFiles } from './book-details-model';

export type BookDetailsTabProps = {
  mode: PlaybackMode;
  /** The codec in words ("AC-3"), for the converted notice ('' when unknown). */
  codec: string;
  serverName: string;
  libraryName: string;
  /** The book's path in its library. */
  path: string;
  files: FileRow[];
  /** Room for the files table's columns (else each file is two lines). */
  roomy: boolean;
};

/**
 * The Details tab (the prototype's `DetailsPanel`): how this device plays the book
 * (direct play, converted for this browser, or from a download), its files with codec,
 * bitrate (about N kbps, from size and length) and length, folded past six, and the path
 * the server knows it by, which is what keys the listener's progress.
 */
export function BookDetailsTab({
  mode,
  codec,
  serverName,
  libraryName,
  path,
  files,
  roomy,
}: BookDetailsTabProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = visibleFiles(files, expanded);
  const notice = {
    direct: {
      icon: 'circle-check',
      tone: 'success',
      title: t('book.details.direct'),
      body: t('book.details.directBody'),
    },
    local: {
      icon: 'hard-drive',
      tone: 'success',
      title: t('book.details.local'),
      body: t('book.details.localBody'),
    },
    converted: {
      icon: 'rotate',
      tone: 'warning',
      title: t('book.details.converted'),
      body: codec
        ? t('book.details.convertedBody', { codec, server: serverName })
        : t('book.details.convertedBodyGeneric', { server: serverName }),
    },
  } as const;
  const kbps = (f: FileRow) => (f.kbps ? t('book.details.kbps', { kbps: f.kbps }) : '');

  return (
    <View className="gap-4">
      <Notice testID={`book-playback-${mode}`} {...notice[mode]} />

      <Card className="overflow-hidden p-0" accessibilityRole="list">
        {roomy ? (
          <View
            className="flex-row gap-3 border-b border-border px-4 py-2.5"
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          >
            <Text variant="caption" className="flex-[3] font-sans-semibold">
              {t('book.details.file')}
            </Text>
            <Text variant="caption" className="flex-1 font-sans-semibold">
              {t('book.details.codec')}
            </Text>
            <Text variant="caption" className="flex-1 font-sans-semibold">
              {t('book.details.bitrate')}
            </Text>
            <Text variant="caption" className="flex-1 font-sans-semibold">
              {t('book.details.length')}
            </Text>
          </View>
        ) : null}
        {shown.map((f, i) => (
          <View
            key={f.key}
            accessible
            accessibilityLabel={[f.name, f.codec, kbps(f), formatDuration(f.duration)]
              .filter(Boolean)
              .join(', ')}
            className={cn(
              'px-4 py-2.5',
              i > 0 && 'border-t border-border',
              roomy ? 'flex-row items-center gap-3' : 'gap-0.5',
            )}
          >
            <Text variant="mono" className={roomy ? 'flex-[3]' : undefined} numberOfLines={2}>
              {f.name}
            </Text>
            {roomy ? (
              <>
                <Text className="flex-1 text-sm">{f.codec}</Text>
                <Text className="flex-1 text-sm" style={tabularNums}>
                  {kbps(f)}
                </Text>
                <Text className="flex-1 text-sm" style={tabularNums}>
                  {formatDuration(f.duration)}
                </Text>
              </>
            ) : (
              <Text variant="caption" style={tabularNums}>
                {[f.codec, kbps(f), formatDuration(f.duration)].filter(Boolean).join(' · ')}
              </Text>
            )}
          </View>
        ))}
        {hidden > 0 ? (
          <AnimatedPressable
            onPress={() => setExpanded(true)}
            accessibilityRole="button"
            className={cn(
              'min-h-[44px] justify-center border-t border-border px-4 py-2.5 active:bg-accent',
              Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
            )}
          >
            <Text variant="muted">{t('book.details.moreFiles', { count: hidden })}</Text>
          </AnimatedPressable>
        ) : null}
      </Card>

      <View className="gap-2">
        <Text variant="label">{t('book.details.pathOn', { server: serverName })}</Text>
        <View className="rounded-[10px] bg-muted px-3 py-2">
          <Text variant="mono" className="text-muted-foreground" selectable>
            {libraryName ? `${libraryName}/` : ''}
            <Text variant="mono">{path}</Text>
          </Text>
        </View>
        <Text variant="caption">{t('book.details.pathNote')}</Text>
      </View>
    </View>
  );
}
