import { AnnotationSection, type AnnotationSectionProps } from '@/components/annotations';

/** A book's notes (the book page's Notes tab, the player companion's):
 * `AnnotationSection` for notes. */
export function NotesSection(props: AnnotationSectionProps) {
  return <AnnotationSection kind="note" {...props} />;
}
