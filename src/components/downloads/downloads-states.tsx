import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { hatchLines } from '@/components/library/ghost-cover';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon, type IconName } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import type { UnsupportedReason } from '@/downloads/downloads-view';
import { useThemeColors } from '@/theme/use-theme-colors';

/** Three dashed, hatched cover outlines leaning on each other: the "nothing here yet"
 * picture of STYLEGUIDE section 8 (ghost covers, never fake art). Decorative. */
function GhostCovers() {
  const themed = useThemeColors();
  const sizes = [64, 80, 64];
  return (
    <View
      className="flex-row items-end gap-2"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {sizes.map((size, i) => (
        <View
          key={i}
          style={{ width: size, height: size }}
          className="overflow-hidden rounded-[5px] border-[1.5px] border-dashed border-subtle-foreground bg-muted"
        >
          <Svg width={size} height={size}>
            {hatchLines(size).map(([x1, y1, x2, y2]) => (
              <Line
                key={x1}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={themed.borderStrong}
                strokeOpacity={0.45}
                strokeWidth={1}
              />
            ))}
          </Svg>
        </View>
      ))}
    </View>
  );
}

/** Nothing downloaded and nothing on its way: ghost covers, one headline, one sentence,
 * one action. */
export function DownloadsEmpty({ onBrowse }: { onBrowse: () => void }) {
  const { t } = useTranslation();
  return (
    <View className="items-center gap-3 px-6 py-12">
      <GhostCovers />
      <Text variant="heading" className="mt-3 text-center">
        {t('downloads.empty.title')}
      </Text>
      <Text variant="muted" className="max-w-[420px] text-center">
        {t('downloads.empty.body')}
      </Text>
      <Button
        title={t('downloads.empty.action')}
        icon="library"
        variant="secondary"
        onPress={onBrowse}
        className="mt-2"
      />
    </View>
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
          <Skeleton className="h-[52px] w-[52px] rounded-[5px]" testID="cover-skeleton" />
          <View className="flex-1 gap-2">
            <Skeleton className="h-3.5 w-1/2 rounded-sm" />
            <Skeleton className="h-3 w-1/3 rounded-sm" />
          </View>
        </View>
      ))}
    </Card>
  );
}
