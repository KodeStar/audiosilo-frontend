import { useTranslation } from 'react-i18next';

import {
  hostIsActive,
  type SheetHostScope,
  usePlayerOnTop,
} from '@/components/player/player-sheets';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';

import { UpNextPanel, useQueuedLine } from './up-next-panel';
import { useUpNext } from './up-next-store';
import { useUpNextData, useUpNextServer } from './use-up-next';

/**
 * Up next on a tablet or phone: the same content as the desktop drawer in the shared
 * bottom `Sheet`, opened from the top bar, the dock, the phone header or Q. Mount it once
 * at the shell's root (it renders in place and must cover the whole app), and once in the
 * full player (`scope="player"`, its Up next pill): the shell's stands back while the
 * player is on top (`hostIsActive`).
 */
export function UpNextSheet({ scope = 'shell' }: { scope?: SheetHostScope }) {
  const { t } = useTranslation();
  const layout = useLayout();
  const open = useUpNext((s) => s.sheetOpen);
  const close = useUpNext((s) => s.closeSheet);
  const { cid, supported } = useUpNextServer();
  const active = hostIsActive(scope, usePlayerOnTop());
  const visible = active && open && layout !== 'desktop' && supported === true && !!cid;
  return (
    <Sheet
      visible={visible}
      onClose={close}
      title={t('upnext.title')}
      scroll
      contentClassName="px-3 pb-4"
    >
      {cid ? <SheetBody cid={cid} onNavigate={close} /> : null}
    </Sheet>
  );
}

function SheetBody({ cid, onNavigate }: { cid: string; onNavigate: () => void }) {
  const data = useUpNextData(cid);
  const subline = useQueuedLine(cid, data.queuedSeconds, data.entries?.length ?? 0);
  return (
    <>
      <Text variant="caption" className="px-2 pb-3">
        {subline}
      </Text>
      <UpNextPanel cid={cid} data={data} onNavigate={onNavigate} />
    </>
  );
}
