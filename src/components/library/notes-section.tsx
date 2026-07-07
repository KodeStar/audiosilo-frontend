import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useMarkdown } from 'react-native-marked';

import { useAddNote, useDeleteNote, useNotes } from '@/api/hooks';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

// Quiet card surface shared by the composer and each rendered note.
const CARD =
  'rounded-xl bg-white p-3 shadow-sm dark:border dark:border-gray-750 dark:bg-gray-840 dark:shadow-none';

/** Renders one note's markdown. useMarkdown is a hook, so it lives in its own
 * component (one instance per note). */
function NoteMarkdown({ body }: { body: string }) {
  const { scheme } = useTheme();
  const elements = useMarkdown(body, { colorScheme: scheme });
  return (
    <View>
      {elements.map((el, i) => (
        <Fragment key={i}>{el}</Fragment>
      ))}
    </View>
  );
}

/** Free-form markdown notes for a book: add, render, delete. */
export function NotesSection({
  libraryId,
  path,
  connectionId,
  hideHeader,
}: {
  libraryId: number;
  path: string;
  /** Source connection; defaults to the active one. The player passes the playing
   * book's connection so notes address the right server. */
  connectionId?: string;
  /** Suppress the internal heading when the caller supplies one (the player sheet's
   * own title bar), so the sheet doesn't show two stacked headings. */
  hideHeader?: boolean;
}) {
  const { t } = useTranslation();
  const { data: notes } = useNotes(libraryId, path, connectionId);
  const add = useAddNote(libraryId, path, connectionId);
  const del = useDeleteNote(libraryId, path, connectionId);
  const [draft, setDraft] = useState('');

  const onAdd = () => {
    const body = draft.trim();
    if (!body) return;
    add.mutate({ body }, { onSuccess: () => setDraft('') });
  };

  return (
    <View className="gap-2">
      {hideHeader ? null : <SectionHeader title={t('library.notes.title')} />}
      <View className={`gap-2 ${CARD}`}>
        <TextField
          placeholder={t('library.notes.placeholder')}
          value={draft}
          onChangeText={setDraft}
          multiline
          textAlignVertical="top"
          className="min-h-[64px]"
          containerClassName="mb-0"
        />
        <Button
          title={t('library.notes.add')}
          icon="plus"
          onPress={onAdd}
          loading={add.isPending}
        />
      </View>

      {notes?.map((note) => (
        <View key={note.id} className={CARD}>
          <NoteMarkdown body={note.body} />
          <View className="mt-2 flex-row items-center justify-between">
            <Text variant="caption">{new Date(note.created_at).toLocaleDateString()}</Text>
            <AnimatedPressable
              onPress={() => del.mutate(note.id)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('library.notes.delete')}
              className="h-8 w-8 items-center justify-center"
            >
              <Icon name="trash" size={16} color={colors.danger} />
            </AnimatedPressable>
          </View>
        </View>
      ))}
    </View>
  );
}
