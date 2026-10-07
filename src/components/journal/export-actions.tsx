import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Text } from '@/components/ui/text';
import { formatCount } from '@/lib/format';
import { tabularNums } from '@/theme/tabular-nums';

import type { ExportAction, ExportFormat } from './use-journal-export';

/** One export choice: what it says and what it runs. */
type Choice = {
  id: string;
  label: string;
  icon?: 'share' | 'download';
  format: ExportFormat;
  action: ExportAction;
};

/** The choices on this platform: native shares a file; the web copies Markdown or
 * downloads either file. */
function exportChoices(platform: string, t: TFunction): { primary: Choice | null; more: Choice[] } {
  if (platform === 'web') {
    return {
      primary: {
        id: 'copy-md',
        label: t('journal.export.copyMarkdown'),
        format: 'md',
        action: 'copy',
      },
      more: [
        {
          id: 'download-md',
          label: t('journal.export.downloadMarkdown'),
          icon: 'download',
          format: 'md',
          action: 'save',
        },
        {
          id: 'download-csv',
          label: t('journal.export.downloadCsv'),
          icon: 'download',
          format: 'csv',
          action: 'save',
        },
      ],
    };
  }
  return {
    primary: null,
    more: [
      {
        id: 'share-md',
        label: t('journal.export.shareMarkdown'),
        icon: 'share',
        format: 'md',
        action: 'save',
      },
      {
        id: 'share-csv',
        label: t('journal.export.shareCsv'),
        icon: 'share',
        format: 'csv',
        action: 'save',
      },
    ],
  };
}

/**
 * The Journal's export actions (prototype: "Copy as Markdown" and "CSV" beside the
 * title). Web: Copy as Markdown plus a Download menu (Markdown, CSV); native: one Export
 * menu that shares either file. `compact` (a narrow measured header) folds every choice
 * into the one menu. While an export gathers its rows the trigger spins and a caption
 * counts them.
 */
export function ExportActions({
  compact,
  disabled,
  preparing,
  onRun,
}: {
  compact: boolean;
  disabled: boolean;
  preparing: number | null;
  onRun: (format: ExportFormat, action: ExportAction) => void;
}) {
  const { t } = useTranslation();
  const { primary, more } = exportChoices(Platform.OS, t);
  const busy = preparing !== null;
  const menuItems = compact && primary ? [primary, ...more] : more;
  const web = Platform.OS === 'web';
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      {primary && !compact ? (
        <Button
          variant="outline"
          size="sm"
          title={primary.label}
          disabled={disabled || busy}
          onPress={() => onRun(primary.format, primary.action)}
        />
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled || busy}>
          <Button
            variant={primary && !compact ? 'ghost' : 'outline'}
            size="sm"
            icon={web ? 'download' : 'share'}
            loading={busy}
            disabled={disabled}
            title={web && !compact ? t('journal.export.download') : t('journal.export.label')}
            accessibilityLabel={t('journal.export.menu')}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {menuItems.map((c) => (
            <DropdownMenuItem key={c.id} icon={c.icon} onPress={() => onRun(c.format, c.action)}>
              <Text>{c.label}</Text>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {busy ? (
        <Text variant="caption" style={tabularNums} accessibilityLiveRegion="polite">
          {t('journal.export.preparing', { count: preparing, n: formatCount(preparing) })}
        </Text>
      ) : null}
    </View>
  );
}
