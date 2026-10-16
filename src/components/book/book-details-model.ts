import type { TFunction } from 'i18next';

import type {
  Book,
  BookFile,
  BookMetaRecording,
  BookMetaWork,
  ChaptersResponse,
} from '@/api/types';
import type { MatchedBookMeta } from '@/components/library/book-meta';
import { getLocale } from '@/i18n/locale';
import { bitrateKbps } from '@/lib/format';
import { bookLabels, LABEL_KINDS, type LabelKind } from '@/lib/labels';
import { codecLabel } from '@/playback/transcode';

import { fileName } from './book-page-model';

/**
 * The Details tab's rules (the prototype's `DetailsPanel`): how this device plays the
 * book, its files with codec, bitrate and length, and where it lives; and the aside's
 * About card. Pure.
 */

/** Files listed before the rest fold into "and N more files". */
export const FILES_SHOWN = 6;

export type FileRow = {
  key: string;
  /** The file's path inside the book's folder (a disc folder stays). */
  name: string;
  codec: string;
  /** Average kilobits a second (`bitrateKbps`), or null when not derivable. */
  kbps: number | null;
  /** Seconds (0 when unknown). */
  duration: number;
};

/**
 * The book's files: the chapters response's (the full list), else the item's, else the
 * book itself as one file (a single-file book, or a book whose files aren't known yet).
 * The codec is the book's: the server probes one per book.
 */
export function fileRows(
  book: Pick<Book, 'rel_path' | 'size' | 'duration' | 'codec' | 'files'>,
  chapterData?: Pick<ChaptersResponse, 'files' | 'codec'>,
): FileRow[] {
  const codec = codecLabel(chapterData?.codec || book.codec);
  const files: Pick<BookFile, 'rel_path' | 'size' | 'duration'>[] = chapterData?.files?.length
    ? chapterData.files
    : book.files?.length
      ? book.files
      : [{ rel_path: book.rel_path, size: book.size, duration: book.duration }];
  return files.map((f) => ({
    key: f.rel_path,
    name: fileName(f.rel_path, book.rel_path),
    codec,
    kbps: bitrateKbps(f.size, f.duration),
    duration: Math.max(0, f.duration || 0),
  }));
}

/** The rows to show: the first `FILES_SHOWN` (all once `expanded`), and how many are
 * folded away. */
export function visibleFiles<T>(rows: readonly T[], expanded: boolean) {
  if (expanded || rows.length <= FILES_SHOWN) return { shown: rows, hidden: 0 };
  return { shown: rows.slice(0, FILES_SHOWN), hidden: rows.length - FILES_SHOWN };
}

/**
 * How this device plays the book: from a download on this device (the original files),
 * converted by the server for this browser (web only, exactly playback's rule:
 * `useNeedsWebTranscode`), or the original file streamed as it is. Native always plays
 * the original.
 */
export type PlaybackMode = 'local' | 'converted' | 'direct';

export function playbackMode(input: { downloaded: boolean; transcoded: boolean }): PlaybackMode {
  if (input.downloaded) return 'local';
  return input.transcoded ? 'converted' : 'direct';
}

/** A book's genres or tags as the About card shows them: the names, one per label. */
export type LabelGroup = { kind: LabelKind; names: string[] };

/** What the About card says (`aboutContent`). */
export type AboutContent = {
  /** Never empty: an undescribed book still reads complete. */
  text: string;
  /** The text is the community's (CC BY-SA), which needs the attribution beside it. */
  community: boolean;
  /** The text is the description a Bridge generated on this server (Bridge Phase 1c),
   * which wears the "Generated on this server" mark and never the community's credit. */
  generated: boolean;
  /** The production facts the community or the server knows, in words. */
  details: { label: string; value: string }[];
  /** The book's genres, then its tags, each kind only when it has some (an older
   * server sends neither). */
  labels: LabelGroup[];
};

/**
 * A language as the sources give it, in words: a code ("en", "eng", "pt-BR") named in
 * the app's language where the platform can (`Intl.DisplayNames`, which Hermes may
 * lack), else the value as it is (a name, "English", or a code there is no name for).
 */
export function languageName(value: string, locale: string = getLocale()): string {
  const v = value.trim();
  const Names = (Intl as { DisplayNames?: typeof Intl.DisplayNames }).DisplayNames;
  if (!Names || !/^[a-z]{2,3}([-_][a-z0-9]{2,8})*$/i.test(v)) return v;
  try {
    const name = new Names([locale], { type: 'language' }).of(v.replace(/_/g, '-'));
    return name && name.toLowerCase() !== v.toLowerCase()
      ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)
      : v;
  } catch {
    return v;
  }
}

/** The book's genres and tags for its chips, as the server sends them (already clean:
 * each label once, no blanks), each kind only when it has some. */
export function labelGroups(book: Pick<Book, 'genres' | 'tags'>): LabelGroup[] {
  return LABEL_KINDS.map((kind) => ({ kind, names: bookLabels(book, kind) })).filter(
    (g) => g.names.length > 0,
  );
}

/** The book's publisher: the server's own, else the community recording's (the About
 * card and the hero's facts). */
export function bookPublisher(
  book: Pick<Book, 'publisher'>,
  recording: Pick<BookMetaRecording, 'publisher'> | undefined,
): string | undefined {
  return book.publisher?.trim() || recording?.publisher;
}

/**
 * The About card's content: the community's description, else the server's own (the
 * admin-edited value), else the work's core description, else the description a Bridge
 * generated on this server (`work`, the `bookMetaWork` value: the matched work or an
 * unmatched book's generated one), else a sentence naming who wrote and reads the book;
 * then the production facts (publisher, release, first published, language, abridged),
 * each only when known, the server's own value before the community's; then the book's
 * genres and tags.
 */
export function aboutContent(
  book: Pick<
    Book,
    | 'title'
    | 'author'
    | 'narrator'
    | 'description'
    | 'published'
    | 'publisher'
    | 'language'
    | 'abridged'
    | 'genres'
    | 'tags'
  >,
  meta: MatchedBookMeta | undefined,
  t: TFunction,
  work?: Pick<BookMetaWork, 'generated' | 'generated_description'>,
): AboutContent {
  const shared = meta?.work.community_description?.text?.trim();
  const own = book.description?.trim() || meta?.work.description?.trim();
  const generated = work?.generated?.description
    ? work.generated_description?.text?.trim()
    : undefined;
  const text =
    shared ||
    own ||
    generated ||
    (book.author && book.narrator
      ? t('book.about.fallbackBoth', {
          title: book.title,
          author: book.author,
          narrator: book.narrator,
        })
      : book.author
        ? t('book.about.fallbackAuthor', { title: book.title, author: book.author })
        : t('book.about.none'));
  const recording = meta?.recording;
  const details: AboutContent['details'] = [];
  const publisher = bookPublisher(book, recording);
  if (publisher) details.push({ label: t('book.meta.publisher'), value: publisher });
  const released = recording?.release_date || book.published;
  if (released) details.push({ label: t('book.meta.released'), value: released });
  if (meta?.work.first_published)
    details.push({ label: t('book.meta.firstPublished'), value: meta.work.first_published });
  const language = book.language?.trim();
  if (language) details.push({ label: t('book.meta.language'), value: languageName(language) });
  // Absent is unknown, never "No": only a value someone gave says either way. The
  // community only ever claims true (its false is also "not recorded"), as the server
  // reads it.
  const abridged =
    typeof book.abridged === 'boolean'
      ? book.abridged
      : recording?.abridged === true
        ? true
        : undefined;
  if (typeof abridged === 'boolean')
    details.push({
      label: t('book.meta.abridged'),
      value: abridged ? t('book.about.yes') : t('book.about.no'),
    });
  return {
    text,
    community: !!shared,
    generated: !shared && !own && !!generated,
    details,
    labels: labelGroups(book),
  };
}
