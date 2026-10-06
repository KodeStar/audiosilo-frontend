import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, ScrollView, View } from 'react-native';

import { ApiError } from '@/api/client';
import {
  CapabilityError,
  useAddCollectionItem,
  useCollection,
  useCollections,
  useCreateCollection,
  useRemoveCollectionItem,
  useSetCollectionShares,
  useShareTargets,
  useUpdateCollection,
} from '@/api/hooks';
import type { Collection } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Input, Textarea } from '@/components/ui/input';
import { ErrorNote } from '@/components/ui/query-state';
import { Skeleton } from '@/components/ui/skeleton';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

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

const checkRowClass = cn(
  'min-h-[48px] flex-row items-center gap-3 rounded-xl px-3 active:bg-accent hover:bg-accent',
  Platform.select({
    web: `cursor-pointer ${FOCUS_RING_CLASS}`,
  }),
);

/** A checkbox row (a share target, a collection holding the book). */
function CheckRow({
  label,
  detail,
  checked,
  busy,
  onPress,
}: {
  label: string;
  detail?: string;
  checked: boolean | undefined;
  busy?: boolean;
  onPress: () => void;
}) {
  const themed = useThemeColors();
  return (
    <Pressable
      role="checkbox"
      aria-checked={!!checked}
      accessibilityState={{ checked: !!checked, busy }}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      disabled={checked === undefined || busy}
      onPress={onPress}
      className={checkRowClass}
    >
      <View
        className={cn(
          'h-5 w-5 items-center justify-center rounded-md border',
          checked ? 'border-primary bg-primary' : 'border-border-strong bg-card',
        )}
      >
        {checked ? <Icon name="check" size={13} color={themed.primaryForeground} /> : null}
      </View>
      <View className="flex-1">
        <Text variant="label" numberOfLines={1}>
          {label}
        </Text>
        {detail ? (
          <Text variant="caption" numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {checked === undefined ? <Skeleton className="h-3 w-10 rounded-sm" /> : null}
    </Pressable>
  );
}

/** The name and description fields of a new or edited collection. */
function CollectionFields({
  name,
  description,
  onName,
  onDescription,
  onSubmit,
}: {
  name: string;
  description: string;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="gap-3">
      <Input
        label={t('library.collection.form.name')}
        value={name}
        onChangeText={onName}
        maxLength={NAME_MAX}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={onSubmit}
      />
      <Textarea
        label={t('library.collection.form.description')}
        value={description}
        onChangeText={onDescription}
        maxLength={DESCRIPTION_MAX}
      />
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
  const [name, setName] = useState(collection?.name ?? '');
  const [description, setDescription] = useState(collection?.description ?? '');
  const create = useCreateCollection(connectionId);
  const update = useUpdateCollection(connectionId);
  const pending = create.isPending || update.isPending;

  const submit = async () => {
    if (!validName(name) || pending) return;
    const fields = { name: name.trim(), description: description.trim() };
    try {
      const saved = collection
        ? await update.mutateAsync({ id: collection.id, ...fields })
        : await create.mutateAsync(fields);
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
        <CollectionFields
          name={name}
          description={description}
          onName={setName}
          onDescription={setDescription}
          onSubmit={() => void submit()}
        />
        <DialogFooter>
          <Button title={t('common.cancel')} variant="ghost" onPress={() => onOpenChange(false)} />
          <Button
            title={t(collection ? 'common.save' : 'library.collection.form.create')}
            disabled={!validName(name)}
            loading={pending}
            onPress={() => void submit()}
          />
        </DialogFooter>
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
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreateCollection(connectionId);
  const add = useAddCollectionItem(connectionId);

  const submit = async () => {
    if (!validName(name) || create.isPending) return;
    try {
      const c = await create.mutateAsync({ name: name.trim(), description: description.trim() });
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
          <>
            <CollectionFields
              name={name}
              description={description}
              onName={setName}
              onDescription={setDescription}
              onSubmit={() => void submit()}
            />
            <DialogFooter>
              <Button
                title={t('common.cancel')}
                variant="ghost"
                onPress={() => setCreating(false)}
              />
              <Button
                title={t('library.collection.form.createAndAdd')}
                disabled={!validName(name)}
                loading={create.isPending || add.isPending}
                onPress={() => void submit()}
              />
            </DialogFooter>
          </>
        ) : (
          <>
            {error && !data ? (
              <ErrorNote message={t('library.collections.error')} onRetry={() => refetch()} />
            ) : isLoading ? (
              <View className="gap-2">
                <Skeleton className="h-11 w-full rounded-xl" />
                <Skeleton className="h-11 w-full rounded-xl" />
              </View>
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
 * Share a collection read-only with people on the same server (owner only; never for a
 * demo account, which the server refuses): the server's share targets as checkboxes,
 * saved as one list.
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
          <View className="gap-2">
            <Skeleton className="h-11 w-full rounded-xl" />
            <Skeleton className="h-11 w-full rounded-xl" />
          </View>
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
