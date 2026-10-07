import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { GhostCovers } from '@/components/ui/ghost-art';
import { Icon, type IconName } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import type { UnsupportedReason } from '@/downloads/downloads-view';
import { useThemeColors } from '@/theme/use-theme-colors';

/** Nothing downloaded and nothing on its way: ghost covers, one headline, one sentence,
 * one action. */
export function DownloadsEmpty({ onBrowse }: { onBrowse: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      art={<GhostCovers size={64} />}
      title={t('downloads.empty.title')}
      hint={t('downloads.empty.body')}
      action={{ label: t('downloads.empty.action'), icon: 'library', onPress: onBrowse }}
    />
  );
}

const UNSUPPORTED_KEY = {
  insecure: 'downloads.unsupported.insecure',
  'no-cache': 'downloads.unsupported.noCache',
  'no-worker': 'downloads.unsupported.noWorker',
} as const satisfies Record<UnsupportedReason, string>;

/** Downloads can't work here (web only): say why and what to do instead. */
export function DownloadsUnsupported({ reason }: { reason: UnsupportedReason }) {
  const { t } = useTranslation();
  return (
    <Notice
      icon="offline"
      title={t('downloads.unsupported.title')}
      body={t(UNSUPPORTED_KEY[reason])}
    />
  );
}

/** A notice (STYLEGUIDE section 8): an icon tile, a bold headline and one sentence,
 * explaining a local situation. */
export function Notice({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  const themed = useThemeColors();
  return (
    <Card className="flex-row items-start gap-4 p-4">
      <View className="h-10 w-10 items-center justify-center rounded-lg bg-info-soft">
        <Icon name={icon} size={18} color={themed.info} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text variant="label">{title}</Text>
        <Text variant="muted">{body}</Text>
      </View>
    </Card>
  );
}

/** Cover-shaped rows while the downloads registry loads (no layout shift). */
export function DownloadsSkeleton() {
  const { t } = useTranslation();
  return (
    <Card
      className="gap-0 p-0"
      accessible
      accessibilityLabel={t('downloads.loading')}
      accessibilityRole="progressbar"
    >
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          className={`flex-row items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t border-border' : ''}`}
        >
          <Skeleton className="h-[52px] w-[52px] rounded-cover" testID="cover-skeleton" />
          <View className="flex-1 gap-2">
            <Skeleton className="h-3.5 w-1/2 rounded-sm" />
            <Skeleton className="h-3 w-1/3 rounded-sm" />
          </View>
        </View>
      ))}
    </Card>
  );
}
