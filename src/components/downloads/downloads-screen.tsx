import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';

import { useAllProgressAll } from '@/api/hooks';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { useTabPress } from '@/components/shell/destinations';
import { SubNavActions } from '@/components/shell/tab-root-nav';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import {
  groupByServer,
  type ServerRef,
  splitDownloads,
  statusSignature,
  storageBar,
  unsupportedReason,
} from '@/downloads/downloads-view';
import { type KeepAheadSlot } from '@/downloads/keep-ahead';
import { useKeepAhead } from '@/downloads/keep-ahead-controller';
import { downloadKey, useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';
import { contentKeyOf } from '@/lib/content-key';
import { formatBytes, formatCount } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { percentHeard } from '@/lib/progress-view';
import { cn } from '@/lib/utils';
import { useSession } from '@/stores/session';
import { tabularNums } from '@/theme/tabular-nums';

import { ActiveRow, PlannedRow, ReadyRow } from './download-rows';
import {
  DownloadsEmpty,
  DownloadsSkeleton,
  DownloadsUnsupported,
  Notice,
} from './downloads-states';
import { RemoveDownloadConfirm } from './remove-download-confirm';
import { RulesCard } from './rules-card';
import { StorageCard } from './storage-card';
import { useStorage } from './use-storage';

type Planned = KeepAheadSlot & { state: 'waiting' | 'no-space' | 'later' };
const isPlanned = (s: KeepAheadSlot): s is Planned =>
  s.state === 'waiting' || s.state === 'no-space' || s.state === 'later';

/** Why downloads are off in this browser (only reached on web: native always can). */
function webUnsupportedReason() {
  const secure = typeof window !== 'undefined' && window.isSecureContext !== false;
  return unsupportedReason({ secure, caches: typeof caches !== 'undefined' });
}

function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <View className="flex-row flex-wrap items-baseline gap-x-3 gap-y-1">
      <Text variant="heading">{title}</Text>
      {sub ? (
        <Text variant="muted" style={tabularNums}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

/** The listener's place in each book, keyed like the registry, for the ready rows. */
function useProgressLabels(): Map<string, string> {
  const { t } = useTranslation();
  const { progress } = useAllProgressAll();
  return useMemo(() => {
    const out = new Map<string, string>();
    for (const p of progress) {
      const key = downloadKey(p.connectionId, p.library_id, p.path);
      out.set(
        key,
        p.finished
          ? t('downloads.row.finished')
          : p.position > 0 && p.duration > 0
            ? t('downloads.row.percent', { percent: percentHeard(p.position, p.duration, false) })
            : t('downloads.row.notStarted'),
      );
    }
    return out;
  }, [progress, t]);
}

/** The narrowest row that takes the storage and rules cards side by side (two 350s). */
const CARDS_BESIDE_MIN = 716;

/**
 * The Downloads tab (Stacks prototype `Downloads`): what is on this device and how much
 * room it takes per server, the automatic download rules, the browser's limits (web),
 * what is downloading or waiting, and the books ready offline grouped by server.
 */
export function DownloadsScreen() {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const [cardsWidth, setCardsWidth] = useState(0);
  const besideCards = !phone && (cardsWidth === 0 || cardsWidth >= CARDS_BESIDE_MIN);
  const paddingBottom = useMiniPlayerInset();
  const { openBook, openPlayer } = useOpen();
  const { press } = useTabPress();

  // The page re-renders when a download starts, lands, fails or goes; a running row
  // follows its own progress (`ActiveRow`).
  const signature = useDownloads((s) => statusSignature(s.entries));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on the signature
  const entries = useMemo(() => useDownloads.getState().entries, [signature]);
  const supported = useDownloads((s) => s.supported);
  const hydrated = useDownloads((s) => s.hydrated);
  const connections = useSession((s) => s.connections);
  const slots = useKeepAhead((s) => s.slots);
  const progressLabels = useProgressLabels();
  const storage = useStorage();
  const [removing, setRemoving] = useState<DownloadEntry | null>(null);

  const servers: ServerRef[] = useMemo(
    () => connections.map((c) => ({ id: c.id, name: c.name })),
    [connections],
  );
  const serverName = (id: string) =>
    servers.find((s) => s.id === id)?.name ?? t('downloads.storage.unknownServer');
  const { active, ready } = useMemo(() => splitDownloads(Object.values(entries)), [entries]);
  const groups = useMemo(() => groupByServer(ready, servers), [ready, servers]);
  // Books the keep-ahead plan is holding back (Wi-Fi, room, its turn) and that aren't in
  // the registry yet.
  const planned = slots
    .filter(isPlanned)
    .filter((s) => !entries[downloadKey(s.book.connectionId, s.book.libraryId, s.book.path)]);

  const scope = storage.estimate?.scope ?? (Platform.OS === 'web' ? 'browser' : 'device');
  const bar = storageBar(groups, storage.estimate, storage.measured);
  const summary =
    scope === 'device'
      ? t('downloads.summary.device', { size: formatBytes(bar.used) })
      : storage.estimate
        ? t('downloads.summary.browserQuota', {
            size: formatBytes(bar.used),
            quota: formatBytes(storage.estimate.capacity),
          })
        : t('downloads.summary.browser', { size: formatBytes(bar.used) });

  const store = useDownloads.getState;
  const retry = (e: DownloadEntry) =>
    store().download(
      e.connectionId,
      e.libraryId,
      e.manifest.book,
      e.manifest.chapters ?? undefined,
    );

  if (hydrated && !supported) {
    return (
      <ScrollView
        className="flex-1"
        contentContainerClassName="p-4 lg:px-8"
        contentContainerStyle={{ paddingBottom }}
      >
        <View className="w-full max-w-[1080px] self-center">
          <DownloadsUnsupported reason={webUnsupportedReason()} />
        </View>
      </ScrollView>
    );
  }

  const nothing = hydrated && active.length === 0 && ready.length === 0 && planned.length === 0;

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="p-4 lg:px-8"
      contentContainerStyle={{ paddingBottom }}
    >
      <View className="w-full max-w-[1080px] gap-6 self-center">
        {/* Tablet/desktop: in the sub-nav beside the title; phone: under the large title. */}
        <SubNavActions tab="(offline)" id="downloads-summary">
          <Text variant="muted" style={tabularNums} className={cn(phone && '-mt-2')}>
            {summary}
          </Text>
        </SubNavActions>

        {/* Top-aligned: the storage card is shorter than the rules and keeps its own height.
            Side by side only where the page fits both (the Up next drawer takes up to 480
            of a desktop, and a 300 rules card cut "On Wi-Fi" short). */}
        <View
          testID="downloads-cards"
          onLayout={(e) => setCardsWidth(e.nativeEvent.layout.width)}
          className={besideCards ? 'flex-row items-start gap-4' : 'gap-4'}
        >
          <StorageCard
            bar={bar}
            scope={scope}
            estimate={storage.estimate}
            className={besideCards ? 'flex-1' : undefined}
          />
          <RulesCard className={besideCards ? 'flex-1' : undefined} />
        </View>

        {Platform.OS === 'web' ? (
          <Notice
            icon="circle-info"
            title={t('downloads.browser.title')}
            body={t('downloads.browser.body')}
          />
        ) : null}

        {!hydrated ? <DownloadsSkeleton /> : null}

        {active.length > 0 || planned.length > 0 ? (
          <View className="gap-3">
            <SectionHead
              title={t('downloads.inProgress.title')}
              sub={formatCount(active.length + planned.length)}
            />
            <Card className="overflow-hidden p-0">
              {active.map((e, i) => (
                <ActiveRow
                  key={downloadKey(e.connectionId, e.libraryId, e.path)}
                  entry={e}
                  server={serverName(e.connectionId)}
                  scope={scope}
                  first={i === 0}
                  onCancel={() => store().cancel(e.connectionId, e.libraryId, e.path)}
                  onRetry={() => retry(e)}
                />
              ))}
              {planned.map((s, i) => (
                <PlannedRow
                  key={contentKeyOf(s.book)}
                  book={s.book}
                  state={s.state}
                  server={serverName(s.book.connectionId)}
                  first={active.length === 0 && i === 0}
                  onCancel={() =>
                    store().cancel(s.book.connectionId, s.book.libraryId, s.book.path)
                  }
                />
              ))}
            </Card>
          </View>
        ) : null}

        {ready.length > 0 ? (
          <View className="gap-3">
            <SectionHead
              title={t('downloads.ready.title')}
              sub={t('downloads.ready.sub', { count: ready.length })}
            />
            {groups.map((g) => (
              <View key={g.connectionId} className="gap-2">
                {groups.length > 1 ? (
                  <Text variant="eyebrow" style={tabularNums}>
                    {t('downloads.ready.serverSize', {
                      server: g.name || t('downloads.storage.unknownServer'),
                      size: formatBytes(g.bytes),
                    })}
                  </Text>
                ) : null}
                <Card className="overflow-hidden p-0">
                  {g.entries.map((e, i) => {
                    const key = downloadKey(e.connectionId, e.libraryId, e.path);
                    return (
                      <ReadyRow
                        key={key}
                        entry={e}
                        progressLabel={progressLabels.get(key)}
                        first={i === 0}
                        onOpen={() => openBook(e.connectionId, e.libraryId, e.path)}
                        onPlay={() => void openPlayer(e.connectionId, e.libraryId, e.path)}
                        onRemove={() => setRemoving(e)}
                      />
                    );
                  })}
                </Card>
              </View>
            ))}
          </View>
        ) : null}

        {nothing ? <DownloadsEmpty onBrowse={() => press('(library)')} /> : null}
      </View>

      <RemoveDownloadConfirm target={removing} onClose={() => setRemoving(null)} />
    </ScrollView>
  );
}
