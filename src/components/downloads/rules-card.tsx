import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { useKeepAhead } from '@/downloads/keep-ahead-controller';
import type { KeepAheadStatus } from '@/downloads/keep-ahead';
import {
  KEEP_AHEAD_CHOICES,
  toKeepAhead,
  useSettings,
  type AutoDownloadMode,
  type KeepAhead,
} from '@/stores/settings';

type KeepAheadValue = `${KeepAhead}`;

/** The Off / 1 / 2 / 3 choices, shared with the Settings screen (one setting, two
 * places that show it). */
export function useKeepAheadOptions(): SegmentedOption<KeepAheadValue>[] {
  const { t } = useTranslation();
  return KEEP_AHEAD_CHOICES.map((n) => ({
    value: `${n}`,
    label: n === 0 ? t('downloads.rules.keepAhead.off') : String(n),
  }));
}

export const keepAheadValue = (n: KeepAhead): KeepAheadValue => `${n}`;
export const parseKeepAhead = (v: KeepAheadValue): KeepAhead => toKeepAhead(Number(v));

const STATUS_KEY = {
  off: null,
  idle: 'downloads.rules.keepAheadStatus.idle',
  never: 'downloads.rules.keepAheadStatus.never',
  working: 'downloads.rules.keepAheadStatus.working',
  ready: 'downloads.rules.keepAheadStatus.ready',
  waiting: 'downloads.rules.keepAheadStatus.waiting',
  'no-space': 'downloads.rules.keepAheadStatus.noSpace',
  failed: 'downloads.rules.keepAheadStatus.failed',
  declined: 'downloads.rules.keepAheadStatus.declined',
} as const satisfies Record<KeepAheadStatus, string | null>;

/** One line on what "Keep the next books ready" is doing right now, from the controller
 * (`useKeepAhead`). `never` wins over a stale plan: automatic downloads are off. */
export function KeepAheadStatusLine({ className }: { className?: string }) {
  const { t } = useTranslation();
  const status = useKeepAhead((s) => s.status);
  const count = useSettings((s) => s.keepAhead);
  const mode = useSettings((s) => s.autoDownloadNext);
  const shown: KeepAheadStatus =
    count === 0 ? 'off' : mode === 'never' ? 'never' : status === 'off' ? 'idle' : status;
  const key = STATUS_KEY[shown];
  if (!key) return null;
  return (
    <Text
      variant="caption"
      className={cn(shown === 'no-space' && 'text-warning', className)}
      accessibilityLiveRegion="polite"
    >
      {t(key)}
    </Text>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border py-3">
      <View className="min-w-[180px] flex-1 gap-0.5">
        <Text className="text-sm">{label}</Text>
        {hint}
      </View>
      {children}
    </View>
  );
}

/**
 * "Automatic downloads": the network rule (`autoDownloadNext`), "Keep the next books
 * ready" (`keepAhead`) and "Remove a download when you finish the book"
 * (`autoDeleteFinished`). The same settings as the Settings screen's Up next section,
 * read and written through the one store.
 */
export function RulesCard({ className }: { className?: string }) {
  const { t } = useTranslation();
  const mode = useSettings((s) => s.autoDownloadNext);
  const setMode = useSettings((s) => s.setAutoDownloadNext);
  const keepAhead = useSettings((s) => s.keepAhead);
  const setKeepAhead = useSettings((s) => s.setKeepAhead);
  const autoDelete = useSettings((s) => s.autoDeleteFinished);
  const setAutoDelete = useSettings((s) => s.setAutoDeleteFinished);
  const keepAheadOptions = useKeepAheadOptions();

  const modes: SegmentedOption<AutoDownloadMode>[] = [
    { value: 'never', label: t('downloads.rules.mode.never') },
    { value: 'wifi', label: t('downloads.rules.mode.wifi') },
    { value: 'always', label: t('downloads.rules.mode.always') },
  ];

  return (
    <Card className={className}>
      <Text variant="title" className="mb-3">
        {t('downloads.rules.title')}
      </Text>
      <View className="gap-2 pb-3">
        <SegmentedControl
          options={modes}
          value={mode}
          onChange={setMode}
          grow
          accessibilityLabel={t('downloads.rules.mode.label')}
        />
        <Text variant="caption">{t('downloads.rules.modeHint')}</Text>
        {/* canAutoDownload lets a browser download on any connection under On Wi-Fi:
            say so rather than imply a check that can't happen. */}
        {Platform.OS === 'web' && mode === 'wifi' ? (
          <Text variant="caption">{t('downloads.rules.webWifi')}</Text>
        ) : null}
      </View>
      <Row
        label={t('downloads.rules.keepAhead.label')}
        hint={
          <>
            <Text variant="caption">{t('downloads.rules.keepAhead.hint')}</Text>
            <KeepAheadStatusLine />
          </>
        }
      >
        <SegmentedControl
          options={keepAheadOptions}
          value={keepAheadValue(keepAhead)}
          onChange={(v) => setKeepAhead(parseKeepAhead(v))}
          accessibilityLabel={t('downloads.rules.keepAhead.label')}
        />
      </Row>
      <Row label={t('downloads.rules.autoDelete')}>
        <Switch
          checked={autoDelete}
          onCheckedChange={setAutoDelete}
          accessibilityLabel={t('downloads.rules.autoDelete')}
        />
      </Row>
    </Card>
  );
}
