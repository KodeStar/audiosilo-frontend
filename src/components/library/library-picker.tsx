import { useTranslation } from 'react-i18next';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

import { useSelectedLibrary } from './use-selected-library';

const optionValue = (connectionId: string, libraryId: number) => `${connectionId}\n${libraryId}`;

/**
 * Picks the library the Library tab's browse modes show (`useSelectedLibrary`). Libraries
 * are grouped under their server's name when more than one server has any. Renders
 * nothing when there is only one library in all (nothing to choose).
 */
export function LibraryPicker({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { groups, library, select } = useSelectedLibrary();
  const withLibraries = groups.filter((g) => g.libraries.length > 0);
  const total = withLibraries.reduce((n, g) => n + g.libraries.length, 0);
  if (total < 2) return null;
  const grouped = withLibraries.length > 1;
  const value = library
    ? {
        value: optionValue(library.connectionId, library.id),
        label: grouped ? `${library.name} · ${library.connectionName}` : library.name,
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
        className={cn('h-[34px] min-w-[140px] max-w-[260px] shrink', className)}
        accessibilityLabel={t('library.picker.label')}
      >
        <SelectValue placeholder={t('library.picker.placeholder')} />
      </SelectTrigger>
      <SelectContent align="end">
        {withLibraries.map((g) =>
          grouped ? (
            <SelectGroup key={g.connectionId}>
              <SelectLabel>{g.connectionName}</SelectLabel>
              {g.libraries.map((l) => (
                <SelectItem
                  key={l.id}
                  value={optionValue(g.connectionId, l.id)}
                  label={`${l.name} · ${g.connectionName}`}
                />
              ))}
            </SelectGroup>
          ) : (
            g.libraries.map((l) => (
              <SelectItem key={l.id} value={optionValue(g.connectionId, l.id)} label={l.name} />
            ))
          ),
        )}
      </SelectContent>
    </Select>
  );
}
