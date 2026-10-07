import { Fragment } from 'react';
import { View } from 'react-native';
import { useMarkdown } from 'react-native-marked';

import type { Note } from '@/api/types';
import { useTheme } from '@/theme/theme-provider';

import { AnnotationRow, type AnnotationRowProps } from './annotation-row';

/** A note's markdown body. `useMarkdown` is a hook, so each note renders its own. */
export function NoteMarkdown({ body }: { body: string }) {
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

export type NoteRowProps = AnnotationRowProps & { note: Note };

/** One note (`AnnotationRow`): a `community` time chip at the place it is pinned to (a
 * note made before notes had places reads 0:00), the markdown body, then the shared meta
 * line and actions. */
export function NoteRow({ note, ...props }: NoteRowProps) {
  return (
    <AnnotationRow kind="note" row={note} {...props}>
      <NoteMarkdown body={note.body} />
    </AnnotationRow>
  );
}
