import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import type { StorageBar, StorageSegment } from '@/downloads/downloads-view';
import type { StorageEstimate } from '@/downloads/types';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

/** `chart-1..5`, spelled out so the class names exist for the style compiler. */
const CHART_BG = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'];
const MUTED_SEGMENT = 'bg-foreground/30';

function segmentClass(s: StorageSegment): string {
  return s.kind === 'server' ? CHART_BG[s.colour - 1] : MUTED_SEGMENT;
}

/** Where the storage lives, for the titles: the browser's quota on web, the disk on a
 * device. */
export type StorageScope = StorageEstimate['scope'];

/**
 * "Storage on this browser / device" (STYLEGUIDE section 8, stat and chart rules): the
 * used total, one bar with a segment per server in `CHART_ORDER` (blue first: the page's
 * pink is its progress and switches), plus "Other apps" on a device, where it is
 * knowable, a legend that names every segment with its size
 * (status is never colour alone), and one line on the room left. The bar is an image
 * with a full label; the legend is its text alternative.
 */
export function StorageCard({
  bar,
  scope,
  estimate,
  className,
}: {
  bar: StorageBar;
  scope: StorageScope;
  estimate: StorageEstimate | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = (s: StorageSegment) =>
    s.kind === 'server'
      ? s.name || t('downloads.storage.unknownServer')
      : s.kind === 'more-servers'
        ? t('downloads.storage.moreServers', { count: s.count })
        : t('downloads.storage.otherApps');
  const legend = bar.segments.map((s) =>
    t('downloads.storage.legend', { name: label(s), size: formatBytes(s.bytes) }),
  );
  const note =
    scope === 'device'
      ? estimate
        ? t('downloads.storage.freeDevice', { size: formatBytes(estimate.free) })
        : null
      : estimate
        ? t('downloads.storage.browserRoom', { size: formatBytes(estimate.free) })
        : t('downloads.storage.browserUnknown');

  return (
    <Card className={cn('gap-3', className)}>
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Text variant="title">
          {scope === 'device'
            ? t('downloads.storage.titleDevice')
            : t('downloads.storage.titleBrowser')}
        </Text>
        <Text variant="muted" style={tabularNums}>
          {t('downloads.storage.used', { size: formatBytes(bar.used) })}
        </Text>
      </View>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={[t('downloads.storage.label'), ...legend].join(', ')}
        className="h-2.5 flex-row overflow-hidden rounded-full bg-muted"
      >
        {bar.scale > 0
          ? bar.segments.map((s, i) => (
              <View
                key={s.kind === 'server' ? s.connectionId : s.kind}
                className={cn('h-full', segmentClass(s), i > 0 && 'border-l-2 border-card')}
                // A sliver stays visible however small its share.
                style={{ width: `${Math.max(0.8, (s.bytes / bar.scale) * 100)}%` }}
              />
            ))
          : null}
      </View>
      {bar.segments.length > 0 ? (
        <View className="flex-row flex-wrap gap-x-4 gap-y-1.5">
          {bar.segments.map((s, i) => (
            <View
              key={s.kind === 'server' ? s.connectionId : s.kind}
              className="flex-row items-center gap-1.5"
            >
              <View className={cn('h-2.5 w-2.5 rounded-sm', segmentClass(s))} />
              <Text variant="caption" style={tabularNums}>
                {legend[i]}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {note ? <Text variant="caption">{note}</Text> : null}
    </Card>
  );
}
