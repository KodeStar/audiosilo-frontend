import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { ApiError } from '@/api/client';
import {
  CapabilityError,
  useAddCollectionItem,
  useCollection,
  useCollections,
  useCreateCollection,
  useRemoveCollectionItem,
  useSetCollectionShares,
  useHouseholdMembers,
  useShareTargets,
  useUpdateCollection,
} from '@/api/hooks';
import type { Collection, HouseholdMember } from '@/api/types';
import { CheckRow } from '@/components/ui/check-row';
import { collectionsMembers } from '@/components/household/household-model';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { ErrorNote } from '@/components/ui/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';

import { findQueued } from '../use-queue-actions';
import {
  DESCRIPTION_MAX,
  NAME_MAX,
  ownCollections,
  sharedIds,
  toggleId,
  validName,
} from './collections-model';

/** Say why a collection write failed (a toast), unless it was never sent (a
 * `CapabilityError`, which must not reach the reachability tracker either). A 409 is a
 * full collection (adding a book) or too many collections (creating one). */
export function collectionFailed(e: unknown, t: TFunction, conflict?: 'full' | 'tooMany') {
  if (e instanceof CapabilityError) return;
  const key =
    e instanceof ApiError && e.status === 409 && conflict
      ? conflict === 'full'
        ? 'library.collection.full'
        : 'library.collection.tooMany'
      : 'library.collection.failed';
  toast({ title: t(key) });
}

/** The name and description of a new or edited collection, and saving them. */
function useCollectionForm(connectionId: string, collection?: Collection) {
  const [name, setName] = useState(collection?.name ?? '');
  const [description, setDescription] = useState(collection?.description ?? '');
  const create = useCreateCollection(connectionId);
  const update = useUpdateCollection(connectionId);
  const pending = create.isPending || update.isPending;
  /** The stored collection, or null when there was nothing to save; rejects on a failed
   * write. */
  const save = async (): Promise<Collection | null> => {
    if (!validName(name) || pending) return null;
    const fields = { name: name.trim(), description: description.trim() };
    return collection
      ? update.mutateAsync({ id: collection.id, ...fields })
      : create.mutateAsync(fields);
  };
  return { name, setName, description, setDescription, pending, save };
}

/** The form's fields and its Cancel / submit footer. */
function CollectionForm({
  form,
  submitLabel,
  loading,
  onSubmit,
  onCancel,
}: {
  form: ReturnType<typeof useCollectionForm>;
  submitLabel: string;
  loading: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <View className="gap-3">
        <Input
          label={t('library.collection.form.name')}
          value={form.name}
          onChangeText={form.setName}
          maxLength={NAME_MAX}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={onSubmit}
        />
        <Textarea
          label={t('library.collection.form.description')}
          value={form.description}
          onChangeText={form.setDescription}
          maxLength={DESCRIPTION_MAX}
        />
      </View>
      <DialogFooter>
        <Button title={t('common.cancel')} variant="ghost" onPress={onCancel} />
        <Button
          title={submitLabel}
          disabled={!validName(form.name)}
          loading={loading}
          onPress={onSubmit}
        />
      </DialogFooter>
    </>
  );
}

/** A list's loading rows inside a dialog. */
function ListSkeleton() {
  return (
    <View className="gap-2">
      <Skeleton className="h-11 w-full rounded-xl" />
      <Skeleton className="h-11 w-full rounded-xl" />
    </View>
  );
}

/**
 * New collection, or (with `collection`) rename / describe one the listener owns.
 * `onSaved` gets the stored collection (a new one: to add a book to it, or open it).
 */
export function CollectionFormDialog({
  open,
  onOpenChange,
  connectionId,
  collection,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  collection?: Collection;
  onSaved?: (c: Collection) => void;
}) {
  const { t } = useTranslation();
  const form = useCollectionForm(connectionId, collection);

  const submit = async () => {
    try {
      const saved = await form.save();
      if (!saved) return;
      onOpenChange(false);
      onSaved?.(saved);
    } catch (e) {
      collectionFailed(e, t, collection ? undefined : 'tooMany');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader className="pr-10">
          <DialogTitle>
            {t(
              collection ? 'library.collection.form.editTitle' : 'library.collection.form.newTitle',
            )}
          </DialogTitle>
          {collection ? null : (
            <DialogDescription>{t('library.collection.form.newHint')}</DialogDescription>
          )}
        </DialogHeader>
        <CollectionForm
          form={form}
          submitLabel={t(collection ? 'common.save' : 'library.collection.form.create')}
          loading={form.pending}
          onSubmit={() => void submit()}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/** One of the listener's collections in "Add to collection": checked when it holds the
 * book (read from the collection itself, only while the dialog is open); pressing adds
 * the book or takes it out (by the item's own path: a remove is exact). */
function CollectionToggle({
  collection,
  connectionId,
  libraryId,
  path,
}: {
  collection: Collection;
  connectionId: string;
  libraryId: number;
  path: string;
}) {
  const { t } = useTranslation();
  const { data } = useCollection(collection.id, connectionId);
  const add = useAddCollectionItem(connectionId);
  const remove = useRemoveCollectionItem(connectionId);
  const item = data ? (findQueued(data.items, libraryId, path) ?? null) : undefined;
  const toggle = () => {
    if (item === undefined) return;
    if (item) {
      remove.mutateAsync({ id: collection.id, libraryId, path: item.path }).then(
        () => toast({ title: t('library.collection.removed', { name: collection.name }) }),
        (e: unknown) => collectionFailed(e, t),
      );
    } else {
      add.mutateAsync({ id: collection.id, libraryId, path }).then(
        () => toast({ title: t('library.collection.added', { name: collection.name }) }),
        (e: unknown) => collectionFailed(e, t, 'full'),
      );
    }
  };
  return (
    <CheckRow
      label={collection.name}
      detail={t('library.collections.itemCount', { count: collection.item_count })}
      checked={item === undefined ? undefined : !!item}
      busy={add.isPending || remove.isPending}
      onPress={toggle}
    />
  );
}

/**
 * "Add to collection" for one book: the listener's OWN collections (a shared one can't
 * be changed), each checked when it holds the book and toggled by a press, and "New
 * collection", which creates one and puts the book in it.
 */
export function AddToCollectionDialog({
  open,
  onOpenChange,
  connectionId,
  libraryId,
  path,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  libraryId: number;
  path: string;
  title: string;
}) {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch } = useCollections(connectionId);
  const own = ownCollections(data);
  const [creating, setCreating] = useState(false);
  const form = useCollectionForm(connectionId);
  const add = useAddCollectionItem(connectionId);

  const submit = async () => {
    try {
      const c = await form.save();
      if (!c) return;
      await add.mutateAsync({ id: c.id, libraryId, path });
      toast({ title: t('library.collection.added', { name: c.name }) });
      onOpenChange(false);
    } catch (e) {
      collectionFailed(e, t, 'tooMany');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader className="pr-10">
          <DialogTitle>
            {t(creating ? 'library.collection.form.newTitle' : 'library.collection.addTo.title')}
          </DialogTitle>
          <DialogDescription numberOfLines={2}>{title}</DialogDescription>
        </DialogHeader>
        {creating ? (
          <CollectionForm
            form={form}
            submitLabel={t('library.collection.form.createAndAdd')}
            loading={form.pending || add.isPending}
            onSubmit={() => void submit()}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <>
            {error && !data ? (
              <ErrorNote message={t('library.collections.error')} onRetry={() => refetch()} />
            ) : isLoading ? (
              <ListSkeleton />
            ) : own.length === 0 ? (
              <Text variant="muted">{t('library.collection.addTo.none')}</Text>
            ) : (
              <ScrollView className="max-h-[320px]" contentContainerClassName="gap-1">
                {own.map((c) => (
                  <CollectionToggle
                    key={c.id}
                    collection={c}
                    connectionId={connectionId}
                    libraryId={libraryId}
                    path={path}
                  />
                ))}
              </ScrollView>
            )}
            <DialogFooter>
              <Button
                title={t('library.collections.new')}
                icon="plus"
                variant="outline"
                onPress={() => setCreating(true)}
              />
              <Button title={t('common.done')} onPress={() => onOpenChange(false)} />
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Under the share targets (Phase 8b-1): each picked person who is the listener's own
 * household member on "Only collections I share" gets a line saying that sharing gives
 * them everything in this collection (it widens what they can listen to). Rendered only
 * while the dialog is open, so the members list is asked for then (a server without
 * `household_members` is never asked).
 */
function MemberShareNote({ connectionId, ids }: { connectionId: string; ids: readonly number[] }) {
  const { t } = useTranslation();
  const { data } = useHouseholdMembers(connectionId);
  const members = collectionsMembers(data);
  const picked = ids
    .map((id) => members.get(id))
    .filter((m): m is HouseholdMember => m !== undefined);
  if (picked.length === 0) return null;
  return (
    <View className="gap-1" testID="share-member-note" accessibilityLiveRegion="polite">
      {picked.map((m) => (
        <Text key={m.id} variant="caption">
          {t('household.share.member', { name: m.name })}
        </Text>
      ))}
    </View>
  );
}

/**
 * Share a collection read-only with people on the same server (owner only; never for a
 * demo account, which the server refuses): the server's share targets as checkboxes,
 * saved as one list. A picked household member who can listen only to shared collections
 * is told what sharing gives them (`MemberShareNote`).
 */
export function ShareCollectionDialog({
  open,
  onOpenChange,
  connectionId,
  collection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  collection: Collection;
}) {
  const { t } = useTranslation();
  const targets = useShareTargets(open, connectionId);
  const save = useSetCollectionShares(connectionId);
  const [ids, setIds] = useState(() => sharedIds(collection));

  const submit = async () => {
    try {
      await save.mutateAsync({ id: collection.id, userIds: ids });
      onOpenChange(false);
    } catch (e) {
      collectionFailed(e, t);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader className="pr-10">
          <DialogTitle>
            {t('library.collection.share.title', { name: collection.name })}
          </DialogTitle>
          <DialogDescription>{t('library.collection.share.hint')}</DialogDescription>
        </DialogHeader>
        {targets.error ? (
          <ErrorNote
            message={t('library.collection.share.error')}
            onRetry={() => targets.refetch()}
          />
        ) : !targets.data ? (
          <ListSkeleton />
        ) : targets.data.length === 0 ? (
          <Text variant="muted">{t('library.collection.share.none')}</Text>
        ) : (
          <ScrollView className="max-h-[320px]" contentContainerClassName="gap-1">
            {targets.data.map((u) => (
              <CheckRow
                key={u.id}
                label={u.username}
                checked={ids.includes(u.id)}
                onPress={() => setIds((cur) => toggleId(cur, u.id))}
              />
            ))}
          </ScrollView>
        )}
        <MemberShareNote connectionId={connectionId} ids={ids} />
        <DialogFooter>
          <Button title={t('common.cancel')} variant="ghost" onPress={() => onOpenChange(false)} />
          <Button
            title={t('common.save')}
            loading={save.isPending}
            disabled={!targets.data}
            onPress={() => void submit()}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
