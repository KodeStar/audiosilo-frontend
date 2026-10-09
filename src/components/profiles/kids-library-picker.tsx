import { useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { librariesQuery } from '@/api/hooks';
import { useApiRegistry } from '@/api/provider';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type SelectOption,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { connectionsOfProfile, type Profile, setProfileKids } from '@/stores/profiles';
import { useSession } from '@/stores/session';

/** A library of one of a profile's connections, as the picker offers it. */
export type KidsLibraryOption = { connectionId: string; libraryId: number; label: string };

/** The value a library option carries in the Select. */
const optionValue = (o: { connectionId: string; libraryId: number }) =>
  `${o.connectionId}|${o.libraryId}`;

/**
 * Which library kids mode shows for `profile` (Settings > Household): the libraries its
 * connections list (GET /libraries, the server's scopes are the truth: an admin limits the
 * kid's account there), named with their server when the profile has several. No pick
 * means the first library the kid's connection lists (kids mode's own fallback). Loading,
 * failed (with Retry) and empty states.
 */
export function KidsLibraryPicker({ profile, label }: { profile: Profile; label: string }) {
  const { t } = useTranslation();
  const { clients } = useApiRegistry();
  const connections = useSession((s) => s.connections);
  const own = connectionsOfProfile(connections, profile.connectionIds);
  const results = useQueries({
    queries: own.map((c) => librariesQuery(c.id, clients.get(c.id) ?? null)),
  });
  const loading = results.some((r) => r.isPending && r.fetchStatus !== 'idle');
  const failed = results.filter((r) => r.isError);
  const options: KidsLibraryOption[] = own.flatMap((c, i) =>
    (results[i]?.data ?? []).map((l) => ({
      connectionId: c.id,
      libraryId: l.id,
      label:
        own.length > 1 ? t('profiles.kids.libraryOn', { name: l.name, server: c.name }) : l.name,
    })),
  );

  if (loading && options.length === 0) {
    return (
      <View className="flex-row items-center gap-2" accessibilityLiveRegion="polite">
        <Spinner />
        <Text variant="caption">{t('profiles.kids.librariesLoading')}</Text>
      </View>
    );
  }
  if (options.length === 0) {
    return (
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1.5">
        <Text variant="caption" className={failed.length ? 'text-destructive' : undefined}>
          {failed.length ? t('profiles.kids.librariesFailed') : t('profiles.kids.noLibraries')}
        </Text>
        {failed.length ? (
          <Button
            title={t('common.retry')}
            icon="rotate"
            variant="outline"
            size="sm"
            onPress={() => failed.forEach((r) => void r.refetch())}
          />
        ) : null}
      </View>
    );
  }

  const picked = profile.kids?.library;
  const current = picked ? options.find((o) => optionValue(o) === optionValue(picked)) : undefined;
  const first = options[0];
  const value: SelectOption = current
    ? { value: optionValue(current), label: current.label }
    : { value: '', label: t('profiles.kids.firstLibrary', { name: first.label }) };

  return (
    <Select
      value={value}
      onValueChange={(o) => {
        const hit = options.find((x) => optionValue(x) === o?.value);
        if (!hit || !profile.kids) return;
        setProfileKids(profile.id, {
          ...profile.kids,
          library: { connectionId: hit.connectionId, libraryId: hit.libraryId },
        });
      }}
    >
      <SelectTrigger className="min-w-[180px] shrink" accessibilityLabel={label}>
        <SelectValue placeholder={value.label} />
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((o) => (
          <SelectItem key={optionValue(o)} value={optionValue(o)} label={o.label} />
        ))}
      </SelectContent>
    </Select>
  );
}
