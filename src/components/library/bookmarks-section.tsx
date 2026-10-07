import { AnnotationSection, type AnnotationSectionProps } from '@/components/annotations';

/** A book's bookmarks (the book page's Bookmarks tab, the player companion's):
 * `AnnotationSection` for bookmarks. */
export function BookmarksSection(props: AnnotationSectionProps) {
  return <AnnotationSection kind="bookmark" {...props} />;
}
