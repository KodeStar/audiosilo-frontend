import { useTranslation } from 'react-i18next';

import { useSignedOutConnection } from '@/components/layout/sign-in-again';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Text } from '@/components/ui/text';
import { isPodcastLibrary } from '@/lib/library-kind';
import { cn } from '@/lib/utils';

import { useSelectedLibrary } from './use-selected-library';

const optionValue = (connectionId: string, libraryId: number) => `${connectionId}\n${libraryId}`;

/** A podcast library's microphone beside its name (Bridge Phase 2d-1). */
const kindIcon = (l: { kind?: string }) => (isPodcastLibrary(l) ? 'microphone' : undefined);

/**
 * Picks the library the Library tab's browse modes show (`useSelectedLibrary`). With
 * several servers signed in every library is named with its server and listed under it,
 * so what the Library shows is never read as another server's (fe#142). With nothing to
 * choose (the one library there is, shown) it renders nothing, or, among several
 * servers, that library's name and server as plain words. With no library shown (its
 * server has not answered) it still offers the ones the other servers list.
 *
 * `by="server"` is for a mode that belongs to a server rather than a library
 * (Collections): it lists and names the servers only, so it can't read as a library
 * filter. Picking another server selects its first library; the current server keeps the
 * library it has.
 */
export function LibraryPicker({
  by = 'library',
  className,
}: {
  by?: 'library' | 'server';
  className?: string;
}) {
  const { t } = useTranslation();
  const { groups, library, server, select } = useSelectedLibrary();
  const signedOut = useSignedOutConnection(server?.connectionId);
  const withLibraries = groups.filter((g) => g.libraries.length > 0);
  // Several servers signed in: the server is always named.
  const named = groups.length > 1;
  // No library shown while its server's list is on its way (or held, or failed): the
  // picker names the server it waits for, not "Choose a library" (fe#271).
  const waiting =
    named && !library && server && !signedOut
      ? t('library.picker.waiting', { name: server.connectionName })
      : null;
  const total = withLibraries.reduce((n, g) => n + g.libraries.length, 0);
  const choices = by === 'server' ? withLibraries.length : total;
  if (choices === 0 || (choices === 1 && library)) {
    if (!named || !library) return null;
    return (
      <Text
        variant="muted"
        numberOfLines={1}
        testID="library-picker-label"
        className={cn('shrink', className)}
      >
        {by === 'server' ? library.connectionName : `${library.name} · ${library.connectionName}`}
      </Text>
    );
  }
  if (by === 'server') {
    return (
      <Select
        value={library ? { value: library.connectionId, label: library.connectionName } : undefined}
        onValueChange={(o) => {
          if (!o || o.value === library?.connectionId) return;
          const first = withLibraries.find((g) => g.connectionId === o.value)?.libraries[0];
          if (first) select({ connectionId: o.value, libraryId: first.id });
        }}
      >
        <SelectTrigger
          className={cn('min-h-[34px] min-w-[140px] max-w-[260px] shrink', className)}
          accessibilityLabel={t('library.picker.serverLabel')}
        >
          <SelectValue placeholder={waiting ?? t('library.picker.serverPlaceholder')} />
        </SelectTrigger>
        <SelectContent align="end">
          {withLibraries.map((g) => (
            <SelectItem key={g.connectionId} value={g.connectionId} label={g.connectionName} />
          ))}
        </SelectContent>
      </Select>
    );
  }
  const value = library
    ? {
        value: optionValue(library.connectionId, library.id),
        label: named ? `${library.name} · ${library.connectionName}` : library.name,
      }
    : undefined;

  return (
    <Select
      value={value}
      onValueChange={(o) => {
        if (!o) return;
        const [connectionId, id] = o.value.split('\n');
        select({ connectionId, libraryId: Number(id) });
      }}
    >
      <SelectTrigger
        className={cn('min-h-[34px] min-w-[140px] max-w-[260px] shrink', className)}
        accessibilityLabel={t('library.picker.label')}
      >
        <SelectValue placeholder={waiting ?? t('library.picker.placeholder')} />
      </SelectTrigger>
      <SelectContent align="end">
        {withLibraries.map((g) =>
          named ? (
            <SelectGroup key={g.connectionId}>
              <SelectLabel>{g.connectionName}</SelectLabel>
              {g.libraries.map((l) => (
                <SelectItem
                  key={l.id}
                  value={optionValue(g.connectionId, l.id)}
                  label={`${l.name} · ${g.connectionName}`}
                  icon={kindIcon(l)}
                />
              ))}
            </SelectGroup>
          ) : (
            g.libraries.map((l) => (
              <SelectItem
                key={l.id}
                value={optionValue(g.connectionId, l.id)}
                label={l.name}
                icon={kindIcon(l)}
              />
            ))
          ),
        )}
      </SelectContent>
    </Select>
  );
}
