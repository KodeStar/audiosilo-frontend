import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import { useCapability, useCollections, useCreateCollection } from '@/api/hooks';
import type { MemberAccess } from '@/api/types';
import { collectionFailed } from '@/components/library/collections/collection-dialogs';
import { ownCollections, toggleId } from '@/components/library/collections/collections-model';
import { Button } from '@/components/ui/button';
import { ErrorNote } from '@/components/ui/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

import { CheckRow } from './check-row';
import { validMemberName } from './household-model';

/**
 * "What can they listen to?" (Phase 8b-1, the add form and a member card's Change): two
 * radio cards, "Everything I can listen to" and "Only collections I share", and for the
 * second the caller's own collections to share with them plus "Create <Name>'s books".
 */
export function AccessPicker({
  connectionId,
  serverName,
  name,
  access,
  collectionIds,
  onAccess,
  onCollections,
}: {
  connectionId: string;
  serverName: string;
  /** The member's name (typed so far, in the add form): names "Create <Name>'s books". */
  name: string;
  access: MemberAccess;
  collectionIds: readonly number[];
  onAccess: (access: MemberAccess) => void;
  onCollections: (ids: number[]) => void;
}) {
  const { t } = useTranslation();
  const label = t('household.access.title');
  return (
    <View className="gap-2.5" testID="access-picker">
      <Text variant="eyebrow" accessibilityRole="header">
        {label}
      </Text>
      <View role="radiogroup" aria-label={label} accessibilityLabel={label} className="gap-2">
        <AccessOption
          testID="access-all"
          selected={access === 'all'}
          title={t('household.access.all')}
          body={t('household.access.allBody', { server: serverName })}
          onPress={() => onAccess('all')}
        />
        <AccessOption
          testID="access-collections"
          selected={access === 'collections'}
          title={t('household.access.collections')}
          body={t('household.access.collectionsBody')}
          onPress={() => onAccess('collections')}
        />
      </View>
      {access === 'collections' ? (
        <CollectionPicker
          connectionId={connectionId}
          name={name}
          ids={collectionIds}
          onChange={onCollections}
        />
      ) : null}
    </View>
  );
}

/** One radio card: a ring that fills when chosen, the option's name and one line. */
function AccessOption({
  selected,
  title,
  body,
  onPress,
  testID,
}: {
  selected: boolean;
  title: string;
  body: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      role="radio"
      aria-checked={selected}
      accessibilityState={{ checked: selected }}
      accessibilityLabel={`${title}, ${body}`}
      onPress={onPress}
      className={cn(
        'min-h-[56px] flex-row items-start gap-3 rounded-card border bg-card px-3.5 py-3 active:bg-accent',
        selected ? 'border-primary' : 'border-border',
        Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
      )}
    >
      <View
        className={cn(
          'mt-0.5 h-5 w-5 items-center justify-center rounded-full border-2',
          selected ? 'border-primary' : 'border-border-strong',
        )}
      >
        {selected ? <View className="h-2.5 w-2.5 rounded-full bg-primary" /> : null}
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="label">{title}</Text>
        <Text variant="caption">{body}</Text>
      </View>
    </Pressable>
  );
}

/** The caller's own collections as checkboxes (the full set to share with the member),
 * and "Create <Name>'s books", which makes one and ticks it. */
function CollectionPicker({
  connectionId,
  name,
  ids,
  onChange,
}: {
  connectionId: string;
  name: string;
  ids: readonly number[];
  onChange: (ids: number[]) => void;
}) {
  const { t } = useTranslation();
  const available = useCapability('collections', connectionId);
  const { data, isLoading, error, refetch } = useCollections(connectionId);
  const own = ownCollections(data);
  const create = useCreateCollection(connectionId);
  const named = validMemberName(name);

  if (available === false) {
    return <Text variant="muted">{t('household.access.collectionsOff')}</Text>;
  }

  const make = async () => {
    const label = t('household.access.booksName', { name: name.trim() });
    try {
      const c = await create.mutateAsync({ name: label });
      onChange([...ids, c.id]);
      toast({ title: t('household.access.created', { name: c.name }) });
    } catch (e) {
      collectionFailed(e, t, 'tooMany');
    }
  };

  return (
    <View className="gap-2" testID="collection-picker">
      {error && !data ? (
        <ErrorNote message={t('library.collections.error')} onRetry={() => void refetch()} />
      ) : isLoading || available === undefined ? (
        <View className="gap-2" testID="collection-picker-loading">
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
        </View>
      ) : own.length === 0 ? (
        <Text variant="muted">{t('household.access.none')}</Text>
      ) : (
        <View className="gap-1" accessibilityLabel={t('household.access.pickLabel')}>
          {own.map((c) => (
            <CheckRow
              key={c.id}
              testID={`pick-collection-${c.id}`}
              label={c.name}
              detail={t('library.collections.itemCount', { count: c.item_count })}
              checked={ids.includes(c.id)}
              onPress={() => onChange(toggleId(ids, c.id))}
            />
          ))}
        </View>
      )}
      {ids.length === 0 && own.length > 0 ? (
        <Text variant="caption">{t('household.access.noneChosen')}</Text>
      ) : null}
      <Button
        testID="create-member-books"
        variant="outline"
        icon="plus"
        className="self-start"
        title={
          named
            ? t('household.access.create', { name: name.trim() })
            : t('household.access.createUnnamed')
        }
        disabled={!named || available !== true}
        loading={create.isPending}
        onPress={() => void make()}
      />
    </View>
  );
}
