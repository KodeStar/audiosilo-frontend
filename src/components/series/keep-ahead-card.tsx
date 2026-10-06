import { useTranslation } from 'react-i18next';

import { KeepAheadControl, KeepAheadStatusLine } from '@/components/downloads/rules-card';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { useDownloads } from '@/downloads/store';

/**
 * The series page's "Keep ahead offline" shortcut: the SAME `keepAhead` setting the
 * Downloads page's Automatic downloads card and Settings show (it is one device-wide
 * rule, Up next first and then the series, so the copy says so rather than promising
 * this series alone), with its status line. Only where this device can download (the
 * Downloads page's gate), and not before the downloads store knows.
 */
export function KeepAheadCard() {
  const { t } = useTranslation();
  const available = useDownloads((s) => s.hydrated && s.supported);
  if (!available) return null;
  return (
    <Card testID="series-keep-ahead" className="mt-4 gap-2.5 p-4">
      <Text variant="eyebrow">{t('series.keepAhead')}</Text>
      <Text variant="muted">{t('downloads.rules.keepAhead.hint')}</Text>
      <KeepAheadControl className="self-start" />
      <KeepAheadStatusLine />
    </Card>
  );
}
