import { useTranslation } from 'react-i18next';

import { useServerInfo } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Text } from '@/components/ui/text';
import { useOpen } from '@/lib/open';
import { useSession } from '@/stores/session';

import { mayAddLibrivox } from './librivox-model';

/**
 * A books library's menu of admin actions (LibriVox L6): Find on LibriVox, for an admin of
 * a server whose Bridge is online with `librivox` and community metadata on
 * (`mayAddLibrivox`). Nothing at all for anyone else, or on an older server. Beside the
 * Books mode's sort and layout (the sub-nav row on tablet and desktop, the count line on a
 * phone), so it takes its connection as a prop and reads no screen context.
 */
export function LibrivoxMenu({
  connectionId,
  libraryId,
}: {
  connectionId: string;
  libraryId: number;
}) {
  const { t } = useTranslation();
  const { openFindLibrivox } = useOpen();
  const user = useSession((s) => s.connections.find((c) => c.id === connectionId)?.user);
  const server = useServerInfo(connectionId).data;
  if (!mayAddLibrivox(user, server)) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          icon="ellipsis"
          accessibilityLabel={t('librivox.menu.label')}
          testID="books-menu"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          icon="search"
          onPress={() => openFindLibrivox(connectionId, libraryId)}
          testID="books-find-librivox"
        >
          <Text>{t('librivox.menu.find')}</Text>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
