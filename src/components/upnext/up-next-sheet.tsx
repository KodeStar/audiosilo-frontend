import { useTranslation } from 'react-i18next';
import { ScrollView, useWindowDimensions } from 'react-native';

import { useCapability } from '@/api/hooks';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';

import { UpNextPanel, useQueuedLine } from './up-next-panel';
import { useUpNext } from './up-next-store';
import { useUpNextConnection, useUpNextData } from './use-up-next';

/** The tablet sheet floats at this width (STYLEGUIDE section 8, "Sheets"). */
const TABLET_SHEET_WIDTH = 560;
/** The sheet's own chrome above the list (grabber and title row). */
const SHEET_CHROME = 72;
const MAX_FRACTION = 0.85;

/**
 * Up next on a tablet or phone: the same content as the desktop drawer in the shared
 * bottom `Sheet`, opened from the top bar, the dock, the phone header or Q. Mount it once
 * at the shell's root (it renders in place and must cover the whole app).
 */
export function UpNextSheet() {
  const { t } = useTranslation();
  const layout = useLayout();
  const open = useUpNext((s) => s.sheetOpen);
  const close = useUpNext((s) => s.closeSheet);
  const cid = useUpNextConnection();
  const supported = useCapability('queue', cid);
  const visible = open && layout !== 'desktop' && supported === true && !!cid;
  return (
    <Sheet
      visible={visible}
      onClose={close}
      title={t('upnext.title')}
      maxHeightFraction={MAX_FRACTION}
      maxWidth={layout === 'tablet' ? TABLET_SHEET_WIDTH : undefined}
    >
      {cid ? <SheetBody cid={cid} onNavigate={close} /> : null}
    </Sheet>
  );
}

function SheetBody({ cid, onNavigate }: { cid: string; onNavigate: () => void }) {
  const { height } = useWindowDimensions();
  const data = useUpNextData(cid);
  const subline = useQueuedLine(cid, data.queuedSeconds, data.entries?.length ?? 0);
  return (
    <ScrollView
      style={{ maxHeight: Math.round(height * MAX_FRACTION) - SHEET_CHROME }}
      contentContainerClassName="px-3 pb-4"
    >
      <Text variant="caption" className="px-2 pb-3">
        {subline}
      </Text>
      <UpNextPanel cid={cid} data={data} onNavigate={onNavigate} />
    </ScrollView>
  );
}
