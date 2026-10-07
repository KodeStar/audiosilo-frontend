import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';

import { shortcutHint } from '@/components/shell/palette-model';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { Text } from '@/components/ui/text';
import { useSettings } from '@/stores/settings';

import { usePlayerSheets } from './player-sheets';

/** One row: what it does, and its keys ("Space" or "K"). */
function Row({ label, keys }: { label: string; keys: string[] }) {
  const { t } = useTranslation();
  return (
    <View
      className="flex-row items-center justify-between gap-4 border-b border-border py-2.5"
      accessible
      accessibilityLabel={`${label}: ${keys.join(` ${t('player.shortcuts.or')} `)}`}
    >
      <Text variant="body" className="flex-1">
        {label}
      </Text>
      <View className="flex-row items-center gap-1">
        {keys.map((k, i) => (
          <View key={k} className="flex-row items-center gap-1">
            {i > 0 ? (
              <Text variant="caption" className="text-subtle-foreground">
                {t('player.shortcuts.or')}
              </Text>
            ) : null}
            <Kbd>{k}</Kbd>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * The keyboard shortcuts overlay (web, STYLEGUIDE section 11): opened by ?, by anything
 * that calls `usePlayerSheets.getState().openSheet('shortcuts')`. A Dialog (Esc and the
 * backdrop close it). Mounted once by the web shell.
 */
export function ShortcutsDialog() {
  const { t } = useTranslation();
  const open = usePlayerSheets((s) => s.open === 'shortcuts');
  const close = usePlayerSheets((s) => s.close);
  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const platform =
    Platform.OS === 'web' && typeof navigator !== 'undefined' ? navigator.platform : '';
  const rows: [string, string[]][] = [
    [t('player.shortcuts.playPause'), [t('player.shortcuts.space'), 'K']],
    [t('player.controls.skipBack', { seconds: skipBackward }), ['J', '←']],
    [t('player.controls.skipForward', { seconds: skipForward }), ['L', '→']],
    [t('player.shortcuts.chapters'), ['⇧ ←', '⇧ →']],
    [t('player.shortcuts.speed'), ['[', ']']],
    [t('player.shortcuts.bookmark'), ['B']],
    [t('player.shortcuts.player'), ['P']],
    [t('upnext.title'), ['Q']],
    [t('player.shortcuts.palette'), [shortcutHint(platform), '/']],
    [t('player.sleepTimer.title'), ['Z']],
    [t('common.close'), ['Esc']],
    [t('player.shortcuts.help'), ['?']],
  ];
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : close())}>
      {open ? (
        <DialogContent>
          <DialogHeader className="pr-10">
            <DialogTitle>{t('player.shortcuts.title')}</DialogTitle>
            <DialogDescription>{t('player.shortcuts.hint')}</DialogDescription>
          </DialogHeader>
          <ScrollView style={{ maxHeight: 460 }}>
            {rows.map(([label, keys]) => (
              <Row key={label} label={label} keys={keys} />
            ))}
          </ScrollView>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
