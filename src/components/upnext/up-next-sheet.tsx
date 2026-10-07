import { useTranslation } from 'react-i18next';

import { PlayerSheet } from '@/components/player/player-sheet';
import { Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';

import { UpNextPanel, useQueuedLine } from './up-next-panel';
import { useUpNextData, useUpNextServer } from './use-up-next';

/**
 * Up next on a tablet or phone: the same content as the desktop drawer in a player sheet
 * (`usePlayerSheets`' `upnext`, opened from the top bar, the dock, the phone header, the
 * full player's pill or Q through `openUpNext`). `PlayerSheetHost` renders it, so the
 * full player's host shows it over the player and the shell's otherwise. Nothing on a
 * desktop (the drawer), or before the queue's server is known to have `queue`.
 */
export function UpNextSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const layout = useLayout();
  const { cid, supported } = useUpNextServer();
  const shown = visible && layout !== 'desktop' && supported === true && !!cid;
  return (
    <PlayerSheet visible={shown} onClose={onClose} title={t('upnext.title')} className="px-3">
      {cid ? <SheetBody cid={cid} onNavigate={onClose} /> : null}
    </PlayerSheet>
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
