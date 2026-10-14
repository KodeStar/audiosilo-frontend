import type { TFunction } from 'i18next';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import { useCapability, useCollections } from '@/api/hooks';
import type { MemberAccess } from '@/api/types';
import { ownCollections, toggleId } from '@/components/library/collections/collections-model';
import { Button } from '@/components/ui/button';
import { ErrorNote } from '@/components/ui/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { CheckRow } from '@/components/ui/check-row';
import { namedCollection, validMemberName } from './household-model';

/** The name "Create <Name>'s books" gives the new collection (`name` trimmed). */
export function memberBooksName(name: string, t: TFunction): string {
  return t('household.access.booksName', { name: name.trim() });
}

/**
 * "What can they listen to?" (Phase 8b-1, the add form and a member card's Change): two
 * radio cards, "Everything I can listen to" and "Only collections I share", and for the
 * second the caller's own collections to share with them plus "Create <Name>'s books".
 * That one creates nothing here: it shows the new collection ticked (`newBooks`), and the
 * form creates it when it is saved (`useMemberBooks`), so Cancel leaves nothing behind.
 * `showTitle` false: the dialog's own title already asks the question.
 */
export function AccessPicker({
  connectionId,
  serverName,
  name,
  access,
  collectionIds,
  newBooks,
  saving = false,
  showTitle = true,
  onAccess,
  onCollections,
  onNewBooks,
}: {
  connectionId: string;
  serverName: string;
  /** The member's name (typed so far, in the add form): names "Create <Name>'s books". */
  name: string;
  access: MemberAccess;
  collectionIds: readonly number[];
  /** "<Name>'s books" is to be created and shared on save. */
  newBooks: boolean;
  /** The form is being saved: the "<Name>'s books" it creates is its own, never one to
   * pick instead (`CollectionPicker`). */
  saving?: boolean;
  showTitle?: boolean;
  onAccess: (access: MemberAccess) => void;
  onCollections: (ids: number[]) => void;
  onNewBooks: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const label = t('household.access.title');
  return (
    <View className="gap-2.5" testID="access-picker">
      {showTitle ? (
        <Text variant="eyebrow" accessibilityRole="header">
          {label}
        </Text>
      ) : null}
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
          newBooks={newBooks}
          saving={saving}
          onChange={onCollections}
          onNewBooks={onNewBooks}
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
 * and "Create <Name>'s books", which adds the new collection ticked, to be created on
 * save (untick it to take it back); when the caller already has a collection of that
 * name, "Share <Name>'s books" ticks that one instead. */
function CollectionPicker({
  connectionId,
  name,
  ids,
  newBooks,
  saving,
  onChange,
  onNewBooks,
}: {
  connectionId: string;
  name: string;
  ids: readonly number[];
  newBooks: boolean;
  saving: boolean;
  onChange: (ids: number[]) => void;
  onNewBooks: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const available = useCapability('collections', connectionId);
  const { data, isLoading, error, refetch } = useCollections(connectionId);
  const own = ownCollections(data);
  const named = validMemberName(name);
  // A collection of the caller's already named "<Name>'s books" (8b-1, D10): offered,
  // ticked, instead of creating a second one of the same name.
  const existing = named ? namedCollection(own, memberBooksName(name, t)) : undefined;
  const existingId = existing?.id;
  // Chosen to be created before that name was typed or the list arrived: the existing
  // one, ticked, instead. Never while the form is saved: the save creates "<Name>'s books"
  // itself, and the list read again then holds it; adopting it would keep its id in the
  // form after a refused save deleted it again (`useMemberBooks`), refusing every retry.
  useEffect(() => {
    if (saving || !newBooks || existingId === undefined) return;
    onNewBooks(false);
    if (!ids.includes(existingId)) onChange([...ids, existingId]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on the match only
  }, [saving, newBooks, existingId]);

  if (available === false) {
    return <Text variant="muted">{t('household.access.collectionsOff')}</Text>;
  }

  return (
    <View className="gap-2" testID="collection-picker">
      {error && !data ? (
        <ErrorNote message={t('library.collections.error')} onRetry={() => void refetch()} />
      ) : isLoading || available === undefined ? (
        <View className="gap-2" testID="collection-picker-loading">
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
        </View>
      ) : own.length === 0 && !newBooks ? (
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
          {newBooks ? (
            <CheckRow
              testID="pick-new-books"
              label={named ? memberBooksName(name, t) : t('household.access.createUnnamedName')}
              detail={t('household.access.newDetail')}
              checked
              onPress={() => onNewBooks(false)}
            />
          ) : null}
        </View>
      )}
      {ids.length === 0 && !newBooks && own.length > 0 ? (
        <Text variant="caption">{t('household.access.noneChosen')}</Text>
      ) : null}
      {existing ? (
        ids.includes(existing.id) ? null : (
          <Button
            testID="use-member-books"
            variant="outline"
            icon="plus"
            className="self-start"
            title={t('household.access.useExisting', { name: existing.name })}
            onPress={() => onChange([...ids, existing.id])}
          />
        )
      ) : newBooks ? null : (
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
          onPress={() => onNewBooks(true)}
        />
      )}
    </View>
  );
}
