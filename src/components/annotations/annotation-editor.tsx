import { type ReactNode, useState } from 'react';
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
import type { IconName } from '@/components/ui/icon';
import { Textarea } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast, type ToastOptions } from '@/components/ui/toast';
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
  const annotations = useCapability('annotations', request.target.connectionId);
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
  // The sheet itself rises above the iOS keyboard (`Sheet`, `useKeyboardAvoidance`).
  return request.kind === 'bookmark' ? (
    <BookmarkEditor request={request} annotations={annotations} onDone={onDone} />
  ) : (
    <NoteEditor request={request} annotations={annotations} onDone={onDone} />
  );
}

/** What a kind's editor gets: its request, the server's `annotations` flag, and how to
 * close. */
type KindEditorProps<K extends EditorRequest['kind']> = {
  request: Extract<EditorRequest, { kind: K }>;
  annotations: boolean | undefined;
  onDone: () => void;
};

/** A save plan (`bookmarkSave`, `noteSave`). */
type Plan<A, U> =
  | { kind: 'add'; vars: A }
  | { kind: 'update'; patch: U }
  | { kind: 'unchanged' | 'unsupported' | 'empty' };

/** A mutation as `runPlan` drives it. */
type Mutate<V> = {
  mutate: (vars: V, opts: { onSuccess: () => void; onError: (err: unknown) => void }) => void;
};

/**
 * Carry out a save plan: an add or an update (closing, then saying so), nothing for an
 * edit that changes nothing (just close) or nothing written, and an edit the server
 * can't take said as such. A failed update on a server that can't take edits
 * (`CapabilityError`) says that too, anything else `saveFailed`.
 */
function runPlan<A, U>(
  plan: Plan<A, U>,
  run: {
    add: Mutate<A>;
    update: Mutate<U>;
    onDone: () => void;
    added: ToastOptions;
    addFailed: string;
    saved: ToastOptions;
    saveFailed: string;
    unsupported: string;
  },
) {
  const done = (shown: ToastOptions) => () => {
    run.onDone();
    toast(shown);
  };
  switch (plan.kind) {
    case 'empty':
      return;
    case 'unchanged':
      run.onDone();
      return;
    case 'unsupported':
      toast({ title: run.unsupported });
      return;
    case 'add':
      run.add.mutate(plan.vars, {
        onSuccess: done(run.added),
        onError: () => toast({ title: run.addFailed }),
      });
      return;
    case 'update':
      run.update.mutate(plan.patch, {
        onSuccess: done(run.saved),
        onError: (err) =>
          toast({ title: err instanceof CapabilityError ? run.unsupported : run.saveFailed }),
      });
  }
}

/**
 * The shape both editors share: the place line, the fields (`children`), a caption on an
 * edit the server can't take (no `annotations`), and Cancel beside the save button.
 */
function EditorFrame({
  request,
  annotations,
  children,
  onDone,
  save,
}: {
  request: EditorRequest;
  annotations: boolean | undefined;
  children: ReactNode;
  onDone: () => void;
  save: {
    icon: IconName;
    title: string;
    loading: boolean;
    disabled?: boolean;
    onPress: () => void;
    testID: string;
  };
}) {
  const { t } = useTranslation();
  const editing = request.kind === 'bookmark' ? !!request.bookmark : !!request.note;
  return (
    <View className="gap-4 pb-2">
      <PlaceLine request={request} />
      {children}
      {editing && annotations !== true ? (
        <Text variant="caption">{t('annotations.editUnsupported')}</Text>
      ) : null}
      <View className="flex-row flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" title={t('common.cancel')} onPress={onDone} />
        <Button {...save} disabled={save.disabled || (editing && annotations !== true)} />
      </View>
    </View>
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

function BookmarkEditor({ request, annotations, onDone }: KindEditorProps<'bookmark'>) {
  const { t } = useTranslation();
  const { connectionId, libraryId, path } = request.target;
  const add = useAddBookmark(libraryId, path, connectionId);
  const update = useUpdateBookmark(connectionId);
  const [draft, setDraft] = useState(() => initialBookmarkDraft(request.bookmark));
  const time = formatClock(request.position);
  const editing = !!request.bookmark;

  const save = () =>
    runPlan(bookmarkSave(request, draft, annotations), {
      add,
      update,
      onDone,
      added: { title: t('player.bookmarks.added'), description: time },
      addFailed: t('player.bookmarks.addFailed'),
      saved: { title: t('annotations.bookmark.saved'), description: time },
      saveFailed: t('annotations.bookmark.saveFailed'),
      unsupported: t('annotations.editUnsupported'),
    });

  return (
    <EditorFrame
      request={request}
      annotations={annotations}
      onDone={onDone}
      save={{
        icon: 'bookmark',
        title: editing ? t('annotations.bookmark.save') : t('annotations.bookmark.addAt', { time }),
        loading: add.isPending || update.isPending,
        onPress: save,
        testID: 'bookmark-save',
      }}
    >
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
      ) : null}
    </EditorFrame>
  );
}

function NoteEditor({ request, annotations, onDone }: KindEditorProps<'note'>) {
  const { t } = useTranslation();
  const { connectionId, libraryId, path } = request.target;
  const add = useAddNote(libraryId, path, connectionId);
  const update = useUpdateNote(connectionId);
  const [body, setBody] = useState(request.note?.body ?? '');
  const time = formatClock(request.position);
  const editing = !!request.note;

  const save = () =>
    runPlan(noteSave(request, body, annotations), {
      add,
      update,
      onDone,
      added: { title: t('annotations.note.pinned', { time }) },
      addFailed: t('annotations.note.saveFailed'),
      saved: { title: t('annotations.note.saved'), description: time },
      saveFailed: t('annotations.note.saveFailed'),
      unsupported: t('annotations.editUnsupported'),
    });

  return (
    <EditorFrame
      request={request}
      annotations={annotations}
      onDone={onDone}
      save={{
        icon: 'notes',
        title: editing ? t('annotations.note.save') : t('annotations.note.pin'),
        loading: add.isPending || update.isPending,
        disabled: body.trim().length === 0,
        onPress: save,
        testID: 'note-save',
      }}
    >
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
    </EditorFrame>
  );
}
