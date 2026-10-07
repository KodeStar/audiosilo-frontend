import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  CapabilityError,
  useAddBookmark,
  useAddNote,
  useCapability,
  useUpdateBookmark,
  useUpdateNote,
} from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { PlayerSheet } from '@/components/player/player-sheet';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Textarea } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import type { EditorRequest } from '@/lib/annotation-request';
import { formatClock } from '@/lib/format';

import { LabelPicker, TimeChip } from './chips';
import {
  BOOKMARK_NOTE_MAX,
  bookmarkSave,
  initialBookmarkDraft,
  NOTE_BODY_MAX,
  noteSave,
} from './editor-model';
import { useChapterNamer } from './use-book-place';

/** A key per request, so a new request starts a fresh draft. */
function requestKey(r: EditorRequest): string {
  const id = r.kind === 'bookmark' ? r.bookmark?.id : r.note?.id;
  const { connectionId, libraryId, path } = r.target;
  return `${r.kind}|${connectionId}|${libraryId}|${path}|${id ?? `new@${r.position}`}`;
}

/**
 * The bookmark and note editors as a player sheet (`PlayerSheet`: a bottom sheet on a
 * phone, a floating sheet on a tablet, a dialog on desktop), rendered by the active
 * `PlayerSheetHost` from `usePlayerSheets().openEditor`. `request` outlives `visible`
 * (the store keeps it after `close()`), so the sheet slides away with its content.
 */
export function AnnotationEditorSheet({
  visible,
  request,
  onClose,
}: {
  visible: boolean;
  request: EditorRequest | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const title = !request
    ? ''
    : request.kind === 'bookmark'
      ? t(request.bookmark ? 'annotations.bookmark.editTitle' : 'annotations.bookmark.title')
      : t(request.note ? 'annotations.note.editTitle' : 'annotations.note.title');
  return (
    <PlayerSheet visible={visible && !!request} onClose={onClose} title={title}>
      {request ? (
        <AnnotationEditor key={requestKey(request)} request={request} onDone={onClose} />
      ) : null}
    </PlayerSheet>
  );
}

/** The editor for one request, on the request's own connection (gone: says so). */
export function AnnotationEditor({
  request,
  onDone,
}: {
  request: EditorRequest;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const api = useOptionalApi(request.target.connectionId);
  if (!api) {
    return (
      <EmptyState
        icon="server"
        title={t('player.companion.noServerTitle')}
        hint={t('player.companion.noServerHint')}
        className="py-6"
      />
    );
  }
  // The sheet itself rises above the iOS keyboard (`Sheet`, `useKeyboardFrame`).
  return request.kind === 'bookmark' ? (
    <BookmarkEditor request={request} onDone={onDone} />
  ) : (
    <NoteEditor request={request} onDone={onDone} />
  );
}

/** The place: the time chip and the chapter it falls in. */
function PlaceLine({ request }: { request: EditorRequest }) {
  const name = useChapterNamer(request.target)(request.position);
  return (
    <View className="flex-row items-center gap-3">
      <TimeChip
        position={request.position}
        tone={request.kind === 'note' ? 'note' : 'bookmark'}
        size="md"
      />
      {name ? (
        <Text variant="muted" numberOfLines={1} className="flex-1">
          {name}
        </Text>
      ) : null}
    </View>
  );
}

/** Says a failed save: a server that can't take edits (`unsupported`), or anything
 * else (`fallback`). */
function saveFailed(err: unknown, unsupported: string, fallback: string) {
  toast({ title: err instanceof CapabilityError ? unsupported : fallback });
}

function BookmarkEditor({
  request,
  onDone,
}: {
  request: Extract<EditorRequest, { kind: 'bookmark' }>;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { connectionId, libraryId, path } = request.target;
  const annotations = useCapability('annotations', connectionId);
  const add = useAddBookmark(libraryId, path, connectionId);
  const update = useUpdateBookmark(connectionId);
  const [draft, setDraft] = useState(() => initialBookmarkDraft(request.bookmark));
  const time = formatClock(request.position);
  const editing = !!request.bookmark;

  const save = () => {
    const plan = bookmarkSave(request, draft, annotations);
    switch (plan.kind) {
      case 'unchanged':
        onDone();
        return;
      case 'unsupported':
        toast({ title: t('annotations.editUnsupported') });
        return;
      case 'add':
        add.mutate(plan.vars, {
          onSuccess: () => {
            onDone();
            toast({ title: t('player.bookmarks.added'), description: time });
          },
          onError: () => toast({ title: t('player.bookmarks.addFailed') }),
        });
        return;
      case 'update':
        update.mutate(plan.patch, {
          onSuccess: () => {
            onDone();
            toast({ title: t('annotations.bookmark.saved'), description: time });
          },
          onError: (err) =>
            saveFailed(err, t('annotations.editUnsupported'), t('annotations.bookmark.saveFailed')),
        });
    }
  };

  return (
    <View className="gap-4 pb-2">
      <PlaceLine request={request} />
      <Textarea
        label={t('annotations.bookmark.noteLabel')}
        placeholder={t('annotations.bookmark.notePlaceholder')}
        value={draft.note}
        onChangeText={(note) => setDraft((d) => ({ ...d, note }))}
        maxLength={BOOKMARK_NOTE_MAX}
        editable={!editing || annotations === true}
        testID="bookmark-note"
      />
      {annotations === true ? (
        <View className="gap-1.5">
          <Text variant="eyebrow">{t('annotations.labelGroup')}</Text>
          <LabelPicker
            value={draft.label}
            onChange={(label) => setDraft((d) => ({ ...d, label }))}
          />
        </View>
      ) : editing ? (
        <Text variant="caption">{t('annotations.editUnsupported')}</Text>
      ) : null}
      <View className="flex-row flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" title={t('common.cancel')} onPress={onDone} />
        <Button
          icon="bookmark"
          title={
            editing ? t('annotations.bookmark.save') : t('annotations.bookmark.addAt', { time })
          }
          loading={add.isPending || update.isPending}
          disabled={editing && annotations !== true}
          onPress={save}
          testID="bookmark-save"
        />
      </View>
    </View>
  );
}

function NoteEditor({
  request,
  onDone,
}: {
  request: Extract<EditorRequest, { kind: 'note' }>;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { connectionId, libraryId, path } = request.target;
  const annotations = useCapability('annotations', connectionId);
  const add = useAddNote(libraryId, path, connectionId);
  const update = useUpdateNote(connectionId);
  const [body, setBody] = useState(request.note?.body ?? '');
  const time = formatClock(request.position);
  const editing = !!request.note;
  const empty = body.trim().length === 0;

  const save = () => {
    const plan = noteSave(request, body, annotations);
    switch (plan.kind) {
      case 'empty':
        return;
      case 'unchanged':
        onDone();
        return;
      case 'unsupported':
        toast({ title: t('annotations.editUnsupported') });
        return;
      case 'add':
        add.mutate(plan.vars, {
          onSuccess: () => {
            onDone();
            toast({ title: t('annotations.note.pinned', { time }) });
          },
          onError: () => toast({ title: t('annotations.note.saveFailed') }),
        });
        return;
      case 'update':
        update.mutate(plan.patch, {
          onSuccess: () => {
            onDone();
            toast({ title: t('annotations.note.saved'), description: time });
          },
          onError: (err) =>
            saveFailed(err, t('annotations.editUnsupported'), t('annotations.note.saveFailed')),
        });
    }
  };

  return (
    <View className="gap-4 pb-2">
      <PlaceLine request={request} />
      <Textarea
        label={t('annotations.note.bodyLabel')}
        placeholder={t('annotations.note.placeholder')}
        value={body}
        onChangeText={setBody}
        maxLength={NOTE_BODY_MAX}
        editable={!editing || annotations === true}
        className="min-h-[96px]"
        testID="note-body"
      />
      {editing && annotations !== true ? (
        <Text variant="caption">{t('annotations.editUnsupported')}</Text>
      ) : null}
      <View className="flex-row flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" title={t('common.cancel')} onPress={onDone} />
        <Button
          icon="notes"
          title={editing ? t('annotations.note.save') : t('annotations.note.pin')}
          loading={add.isPending || update.isPending}
          disabled={empty || (editing && annotations !== true)}
          onPress={save}
          testID="note-save"
        />
      </View>
    </View>
  );
}
