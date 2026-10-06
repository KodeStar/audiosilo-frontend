import * as DialogPrimitive from '@rn-primitives/dialog';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type NativeSyntheticEvent,
  Platform,
  type Role,
  Pressable,
  ScrollView,
  TextInput,
  type TextInputKeyPressEventData,
  View,
} from 'react-native';

import { type MergedBook, useAllProgressAll, useSourceLabeller } from '@/api/hooks';
import { useApi, useApis } from '@/api/provider';
import { roleLabelKey } from '@/components/library/book-meta';
import { NameToken } from '@/components/search/name-token';
import { type SearchResults, useSearch } from '@/components/search/use-search';
import { DialogOverlay } from '@/components/ui/dialog';
import { withFlatStyle } from '@/components/ui/overlay';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { Kbd } from '@/components/ui/kbd';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { chapterLabel } from '@/lib/chapter-label';
import { useLayout } from '@/lib/layout';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useOpen } from '@/lib/open';
import { pathLeaf } from '@/lib/paths';
import { isInProgress } from '@/lib/progress-view';
import { cn } from '@/lib/utils';
import { useSleepTimer } from '@/playback/sleep-timer';
import { selectCurrentChapter, selectIsPlaying, usePlayer } from '@/playback/store';
import { useRecentSearches } from '@/stores/search';
import { useSession } from '@/stores/session';
import { useTheme } from '@/theme/theme-provider';
import { useThemeColors } from '@/theme/use-theme-colors';
import { isEditable, isModalOpen } from '@/lib/keyboard';

import { TOP_BAR_TABS, useTabPress } from './destinations';
import {
  buildPaletteGroups,
  flattenGroups,
  isPaletteShortcut,
  matchRange,
  MAX_NAMED,
  moveSelection,
  type PaletteCover,
  type PaletteGroupKey,
  type PaletteItem,
} from './palette-model';
import { usePalette } from './palette-store';

/** The minutes the palette's sleep action arms (the guide's "Sleep in 30 minutes"). */
const SLEEP_MINUTES = 30;
/** Search after the typing settles, like the Search screen. */
const DEBOUNCE_MS = 200;

const GROUP_LABEL_KEY = {
  actions: 'palette.groups.actions',
  continue: 'home.continueListening',
  books: 'palette.groups.books',
  series: 'palette.groups.series',
  authors: 'palette.groups.authors',
  narrators: 'palette.groups.narrators',
  characters: 'palette.groups.characters',
  goTo: 'palette.groups.goTo',
} as const satisfies Record<PaletteGroupKey, string>;

/** Through `withFlatStyle`, like every overlay's Content part (see ui/overlay). */
const PaletteContent = withFlatStyle(DialogPrimitive.Content);

const optionId = (index: number) => `palette-option-${index}`;
const LIST_ID = 'palette-list';

/** The palette's Actions for what the app can do right now (only what exists today:
 * the transport, the sleep timer, the full player, settings and appearance). */
function useActionItems(): PaletteItem[] {
  const { t } = useTranslation();
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const isPlaying = usePlayer(selectIsPlaying);
  const chapter = usePlayer(selectCurrentChapter);
  const { scheme, toggleScheme } = useTheme();
  const { press } = useTabPress();

  return useMemo(() => {
    const items: PaletteItem[] = [];
    if (nowPlaying) {
      const chapterName = chapter ? chapterLabel(chapter, t) : null;
      items.push({
        id: 'toggle',
        title: isPlaying
          ? t('player.controls.pause')
          : t('palette.resume', { name: chapterName ?? nowPlaying.title }),
        subtitle: nowPlaying.title,
        icon: isPlaying ? 'pause' : 'play',
        run: () => void usePlayer.getState().toggle(),
      });
      const sleepTitle = t('palette.sleepMinutes', { count: SLEEP_MINUTES });
      const sleepHint = t('palette.sleepFades');
      items.push({
        id: 'sleep-minutes',
        title: sleepTitle,
        subtitle: sleepHint,
        icon: 'sleep',
        run: () => {
          useSleepTimer.getState().startDuration(SLEEP_MINUTES);
          toast({ title: sleepTitle, description: sleepHint });
        },
      });
      // Only with real chapters: without them "end of chapter" falls back to a short
      // duration timer, which this label would misdescribe.
      if (nowPlaying.queue.chapters.length > 0) {
        const title = t('palette.sleepChapter');
        items.push({
          id: 'sleep-chapter',
          title,
          subtitle: chapterName ?? undefined,
          icon: 'sleep',
          run: () => {
            useSleepTimer.getState().startChapterTimer({ allowEndOfBook: true });
            toast({ title, description: chapterName ?? undefined });
          },
        });
      }
      items.push({
        id: 'player',
        title: t('palette.openPlayer'),
        subtitle: nowPlaying.title,
        icon: 'chevron-up',
        run: () => router.push('/player'),
      });
    }
    items.push({
      id: 'settings',
      title: t('palette.settings'),
      subtitle: t('palette.settingsHint'),
      icon: 'settings',
      run: () => press('(me)'),
    });
    const dark = scheme === 'dark';
    items.push({
      id: 'appearance',
      title: dark ? t('palette.light') : t('palette.dark'),
      subtitle: t('settings.appearance.label'),
      icon: 'settings',
      run: toggleScheme,
    });
    return items;
  }, [t, nowPlaying, isPlaying, chapter, scheme, toggleScheme, press]);
}

/** Go to: the top bar's destinations (Downloads only where this browser can keep books). */
function useGoToItems(): PaletteItem[] {
  const { t } = useTranslation();
  const { press } = useTabPress();
  return useMemo(
    () =>
      TOP_BAR_TABS.map((d) => ({
        id: `go:${d.name}`,
        title: t(d.labelKey),
        icon: d.icon,
        run: () => press(d.name),
      })),
    [t, press],
  );
}

/** Books for the query (the cross-server search, from `useSearch`) and, with no query,
 * Continue listening from the progress Home already loads: the cache as is (opening the
 * palette must not refetch every server's progress), and nothing at all while a query
 * is typed. */
function useBookItems(
  query: string,
  found: MergedBook[],
): {
  books: PaletteItem[];
  continueListening: PaletteItem[];
} {
  const { t } = useTranslation();
  const { openBook } = useOpen();
  const sourceOf = useSourceLabeller();
  const { progress } = useAllProgressAll({ enabled: !query, refetchOnMount: false });

  const books = useMemo(
    () =>
      found.map((b): PaletteItem => {
        const title = b.title || pathLeaf(b.rel_path);
        return {
          id: `book:${b.connectionId}:${b.library_id}:${b.rel_path}`,
          title,
          subtitle: [b.author, sourceOf(b.connectionId, b.library_id, b.connectionName)]
            .filter(Boolean)
            .join(' · '),
          cover: { connectionId: b.connectionId, libraryId: b.library_id, path: b.rel_path },
          run: () => openBook(b.connectionId, b.library_id, b.rel_path),
        };
      }),
    [found, sourceOf, openBook],
  );

  const continueListening = useMemo(
    () =>
      progress.filter(isInProgress).map((p): PaletteItem => {
        const percent = p.duration > 0 ? Math.round((p.position / p.duration) * 100) : 0;
        return {
          id: `continue:${p.connectionId}:${p.library_id}:${p.path}`,
          title: pathLeaf(p.path),
          subtitle: [
            t('palette.listened', { percent }),
            sourceOf(p.connectionId, p.library_id, p.connectionName),
          ]
            .filter(Boolean)
            .join(' · '),
          cover: { connectionId: p.connectionId, libraryId: p.library_id, path: p.path },
          run: () => openBook(p.connectionId, p.library_id, p.path),
        };
      }),
    [progress, sourceOf, t, openBook],
  );

  return { books, continueListening };
}

/** Series, authors, narrators and the characters the listener has met, as palette items
 * (the search model already matched, ranked, capped and spoiler-gated them), plus the
 * count of characters not met yet. */
function useNamedItems(results: SearchResults) {
  const { t } = useTranslation();
  const { openSeries, openAuthor, openNarrator, openBook } = useOpen();
  const many = useApis().length > 1;
  const where = (connectionName: string) => (many ? connectionName : null);
  const books = (count: number) => t('search.bookCount', { count });
  return {
    series: results.series.map((s): PaletteItem => ({
      id: `series:${s.source.connectionId}:${s.source.libraryId}:${s.name}`,
      title: s.name,
      subtitle: [books(s.books), s.author, where(s.source.connectionName)]
        .filter(Boolean)
        .join(' · '),
      icon: 'layers',
      run: () => openSeries(s.source.connectionId, s.source.libraryId, { name: s.name }),
    })),
    authors: results.authors.map((p): PaletteItem => ({
      id: `author:${p.source.connectionId}:${p.source.libraryId}:${p.name}`,
      title: p.name,
      subtitle: [t('search.roleAuthor'), books(p.books), where(p.source.connectionName)]
        .filter(Boolean)
        .join(' · '),
      token: { kind: 'author', name: p.name },
      run: () => openAuthor(p.source.connectionId, p.source.libraryId, p.name),
    })),
    narrators: results.narrators.map((p): PaletteItem => ({
      id: `narrator:${p.source.connectionId}:${p.source.libraryId}:${p.name}`,
      title: p.name,
      subtitle: [t('search.roleNarrator'), books(p.books), where(p.source.connectionName)]
        .filter(Boolean)
        .join(' · '),
      token: { kind: 'narrator', name: p.name },
      run: () => openNarrator(p.source.connectionId, p.source.libraryId, p.name),
    })),
    characters: results.characters.hits.map((c): PaletteItem => {
      const roleKey = roleLabelKey(c.role);
      return {
        id: `character:${c.key}`,
        title: c.name,
        subtitle: [roleKey ? t(roleKey) : null, c.bookTitle].filter(Boolean).join(' · '),
        token: { kind: 'character', name: c.name },
        run: () => openBook(c.connectionId, c.libraryId, c.path),
      };
    }),
    charactersNote:
      results.characters.hidden > 0
        ? t('palette.hiddenCharacters', { count: results.characters.hidden })
        : undefined,
  };
}

/** The title with the first match of the query in `brand-ink` bold. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const range = matchRange(text, query);
  return (
    <Text variant="label" numberOfLines={1}>
      {range ? (
        <>
          {text.slice(0, range[0])}
          {/* `label` like the line around it: a bare <Text> would apply the `body`
              variant's larger size to the match. */}
          <Text variant="label" className="font-sans-bold text-brand-ink">
            {text.slice(range[0], range[1])}
          </Text>
          {text.slice(range[1])}
        </>
      ) : (
        text
      )}
    </Text>
  );
}

function CoverThumb({ cover, label }: { cover: PaletteCover; label: string }) {
  const api = useApi(cover.connectionId);
  return (
    <Cover
      source={{ uri: api.coverUrl(cover.libraryId, cover.path), headers: api.authHeaders() }}
      label={label}
      rounded="rounded-[5px]"
      size={36}
    />
  );
}

function Option({
  item,
  index,
  active,
  query,
  onHover,
  onRun,
}: {
  item: PaletteItem;
  index: number;
  active: boolean;
  query: string;
  onHover: (index: number) => void;
  onRun: (item: PaletteItem) => void;
}) {
  const themed = useThemeColors();
  return (
    <Pressable
      nativeID={optionId(index)}
      role="option"
      aria-selected={active}
      accessibilityLabel={item.subtitle ? `${item.title}, ${item.subtitle}` : item.title}
      // The input keeps the focus (aria-activedescendant points here), so the options
      // stay out of the tab order.
      focusable={false}
      onHoverIn={() => onHover(index)}
      onPress={() => onRun(item)}
      className={cn(
        'min-h-[48px] flex-row items-center gap-3 rounded-xl px-2.5 py-2',
        active && 'bg-accent',
        Platform.select({ web: 'cursor-pointer' }),
      )}
    >
      {item.cover ? (
        <CoverThumb cover={item.cover} label={item.title} />
      ) : item.token ? (
        <NameToken name={item.token.name} kind={item.token.kind} size={36} />
      ) : (
        <View className="h-9 w-9 items-center justify-center rounded-control bg-muted">
          <Icon name={item.icon ?? 'chevron-right'} size={17} color={themed.mutedForeground} />
        </View>
      )}
      <View className="flex-1">
        <Highlighted text={item.title} query={query} />
        {item.subtitle ? (
          <Text variant="caption" numberOfLines={1}>
            {item.subtitle}
          </Text>
        ) : null}
      </View>
      {active ? <Kbd>↵</Kbd> : null}
    </Pressable>
  );
}

/** A group's quiet line that is not an option: the characters the listener hasn't met
 * yet, counted (never named), so the arrows skip it. */
function GroupNote({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <View className="min-h-[48px] flex-row items-center gap-3 px-2.5 py-2">
      <NameToken kind="character" size={36} hidden />
      <View className="flex-1">
        <Text variant="label" numberOfLines={2}>
          {text}
        </Text>
        <Text variant="caption">{t('palette.hiddenHint')}</Text>
      </View>
    </View>
  );
}

function PaletteBody() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const query = usePalette((s) => s.query);
  const setQuery = usePalette((s) => s.setQuery);
  const recent = useRecentSearches((s) => s.recent);
  const remember = useRecentSearches((s) => s.remember);
  const close = usePalette((s) => s.close);
  const connections = useSession((s) => s.connections);
  const debounced = useDebouncedValue(query.trim(), DEBOUNCE_MS);
  const [selected, setSelected] = useState(0);

  const actions = useActionItems();
  const goTo = useGoToItems();
  const results = useSearch(debounced, { limit: MAX_NAMED, refetchProgress: false });
  const { books, continueListening } = useBookItems(debounced, results.books);
  const named = useNamedItems(results);
  // Results belong to the debounced query; none while the field is empty.
  const typed = query.trim() !== '';
  const groups = buildPaletteGroups({
    query,
    actions,
    books: typed ? books : [],
    continueListening,
    ...(typed ? named : {}),
    goTo,
  });
  const flat = flattenGroups(groups);
  const active = Math.min(selected, Math.max(0, flat.length - 1));

  // Keep the active option in view while the arrows move through a long list (web).
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const run = (item: PaletteItem) => {
    if (query.trim()) remember(query);
    close();
    item.run();
  };

  const onKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const { key } = e.nativeEvent;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      setSelected(moveSelection(active, key === 'ArrowDown' ? 1 : -1, flat.length));
    } else if (key === 'Enter') {
      e.preventDefault();
      const item = flat[active];
      if (item) run(item);
    }
  };

  const pending = typed && (!results.settled || debounced !== query.trim());
  const servers = connections.map((c) => c.name).join(' + ');

  return (
    <>
      {/* Radix needs a title and description; the field and the footer say it visually. */}
      <DialogPrimitive.Title className="sr-only">{t('palette.label')}</DialogPrimitive.Title>
      <DialogPrimitive.Description className="sr-only">
        {t('palette.hint')}
      </DialogPrimitive.Description>
      <View className="h-[60px] flex-row items-center gap-3 border-b border-border px-[18px]">
        <Icon name="search" size={20} color={themed.mutedForeground} />
        <TextInput
          testID="palette-input"
          autoFocus
          value={query}
          onChangeText={(q) => {
            setQuery(q);
            setSelected(0);
          }}
          onKeyPress={onKeyPress}
          placeholder={t('palette.placeholder')}
          placeholderTextColor={themed.subtleForeground}
          autoCapitalize="none"
          autoCorrect={false}
          role="combobox"
          accessibilityLabel={t('palette.label')}
          aria-expanded
          aria-controls={LIST_ID}
          aria-autocomplete="list"
          aria-activedescendant={flat.length > 0 ? optionId(active) : undefined}
          className={cn(
            'min-w-0 flex-1 font-sans text-[17px] text-foreground',
            Platform.select({ web: 'outline-none' }),
          )}
        />
        {/* eslint-disable-next-line i18next/no-literal-string -- a key name */}
        <Kbd>esc</Kbd>
      </View>

      {!query && recent.length > 0 ? (
        <View className="flex-row flex-wrap items-center gap-1.5 px-4 pt-2.5">
          <Text variant="caption" className="mr-1 text-subtle-foreground">
            {t('palette.recent')}
          </Text>
          {recent.map((r) => (
            <Pressable
              key={r}
              role="button"
              onPress={() => setQuery(r)}
              className={cn(
                'h-[26px] flex-row items-center gap-1 rounded-full border border-border px-2.5 active:bg-accent',
                Platform.select({ web: 'cursor-pointer hover:bg-accent' }),
              )}
            >
              <Icon name="history" size={12} color={themed.mutedForeground} />
              <Text className="font-sans text-xs text-foreground">{r}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <ScrollView
        nativeID={LIST_ID}
        // React Native's Role union lacks `listbox`; react-native-web writes it through.
        role={'listbox' as Role}
        aria-label={t('palette.label')}
        keyboardShouldPersistTaps="handled"
        className="max-h-[min(460px,60vh)]"
        contentContainerClassName="px-2 pb-2.5 pt-1.5"
      >
        {groups.map((g) => (
          <View key={g.key} role="group" aria-label={t(GROUP_LABEL_KEY[g.key])}>
            <Text variant="eyebrow" aria-hidden className="px-2.5 pb-1.5 pt-3">
              {t(GROUP_LABEL_KEY[g.key])}
            </Text>
            {g.items.map((item, i) => (
              <Option
                key={item.id}
                item={item}
                index={g.start + i}
                active={g.start + i === active}
                query={query}
                onHover={setSelected}
                onRun={run}
              />
            ))}
            {g.note ? <GroupNote text={g.note} /> : null}
          </View>
        ))}
        {pending && !groups.some((g) => g.key === 'books') ? (
          <Text variant="caption" className="px-2.5 py-3">
            {t('palette.searching')}
          </Text>
        ) : null}
        {groups.length === 0 && !pending ? (
          <View className="items-center gap-1 px-4 py-7">
            <Text variant="label">{t('palette.empty', { query: query.trim() })}</Text>
            <Text variant="muted">{t('palette.emptyHint')}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View className="flex-row flex-wrap items-center gap-4 border-t border-border bg-muted px-4 py-2.5">
        {(
          [
            { keys: ['↑', '↓'], label: t('palette.keys.move') },
            { keys: ['↵'], label: t('palette.keys.open') },
            { keys: ['esc'], label: t('palette.keys.close') },
          ] as const
        ).map(({ keys, label }) => (
          <View key={label} className="flex-row items-center gap-1">
            {keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
            <Text variant="caption">{label}</Text>
          </View>
        ))}
        <View className="flex-1" />
        <Text variant="caption" accessibilityLiveRegion="polite">
          {servers
            ? t('palette.resultsOn', { count: flat.length, servers })
            : t('palette.results', { count: flat.length })}
        </Text>
      </View>
    </>
  );
}

/**
 * The web command palette (STYLEGUIDE section 8, "Command palette"): a combobox over a
 * grouped listbox - Actions, Books (or Continue listening), Series, Authors, Narrators,
 * Characters (met only; the rest counted), Go to - on the Dialog
 * primitive (focus trap, Esc, `aria-modal`). Open it with `usePalette().openPalette()`:
 * the top bar's omnisearch, ⌘K / Ctrl+K or `/` (`usePaletteShortcut`). Mounted once, by
 * the web shell; native tablets keep the omnisearch's jump to the Search tab.
 */
export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const close = usePalette((s) => s.close);
  const phone = useLayout() === 'phone';
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (next ? null : close())}>
      {open ? (
        <DialogPrimitive.Portal>
          <DialogOverlay
            className={cn(
              'absolute bottom-0 left-0 right-0 top-0 z-50 items-center bg-overlay',
              phone ? 'px-2 pt-2' : 'px-3 pt-3.5',
              Platform.select({ web: 'fixed animate-in fade-in-0 motion-reduce:animate-none' }),
            )}
          >
            <PaletteContent
              className={cn(
                'w-full max-w-[700px] overflow-hidden rounded-dialog border border-border bg-popover shadow-overlay',
                // Radix wraps the content in a shrink-to-fit node; a viewport width is
                // definite whatever it does (see dialog.tsx).
                Platform.select({
                  web: 'w-[min(700px,calc(100vw-1.5rem))] animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none',
                }),
              )}
            >
              <PaletteBody />
            </PaletteContent>
          </DialogOverlay>
        </DialogPrimitive.Portal>
      ) : null}
    </DialogPrimitive.Root>
  );
}

/**
 * The palette's global shortcuts (web): ⌘K / Ctrl+K and `/` open it from any tab page -
 * not over the full player, not over another dialog, and never while typing in a field.
 */
export function usePaletteShortcut(enabled: boolean) {
  const openPalette = usePalette((s) => s.openPalette);
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e, isEditable(document.activeElement))) return;
      if (isModalOpen(document)) return;
      e.preventDefault();
      openPalette();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, openPalette]);
}
