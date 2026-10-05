import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useMarkdown } from 'react-native-marked';

import { useAddNote, useDeleteNote, useNotes } from '@/api/hooks';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/input';
import { useTheme } from '@/theme/theme-provider';
import { useThemeColors } from '@/theme/use-theme-colors';

// Quiet card surface shared by the composer and each rendered note.
const CARD = 'rounded-xl bg-card p-3 shadow-xs dark:border dark:border-border dark:shadow-none';

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
}: {
  libraryId: number;
  path: string;
  /** Source connection; defaults to the active one. The player passes the playing
   * book's connection so notes address the right server. */
  connectionId?: string;
}) {
  const themed = useThemeColors();
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
      <View className={`gap-2 ${CARD}`}>
        <Textarea
          containerClassName="mb-4"
          placeholder={t('library.notes.placeholder')}
          value={draft}
          onChangeText={setDraft}
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
              <Icon name="trash" size={16} color={themed.destructive} />
            </AnimatedPressable>
          </View>
        </View>
      ))}
    </View>
  );
}
