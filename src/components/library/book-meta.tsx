import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, ScrollView, View } from 'react-native';

import { useBookMeta } from '@/api/hooks';
import type { BookMeta, BookMetaSeries, BookMetaSeriesWork } from '@/api/types';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { colors } from '@/theme/tokens';

/** Descriptions past this many characters get a collapse + "show more" toggle.
 * A deterministic length heuristic (rather than an onTextLayout measure pass) so
 * the toggle never flashes and the choice is unit-testable. */
const LONG_DESCRIPTION_CHARS = 300;

/** Whether a description is long enough to warrant the collapse toggle. */
export function descriptionIsLong(text: string | undefined): boolean {
  return (text?.length ?? 0) > LONG_DESCRIPTION_CHARS;
}

/** The series works to show in a rail: every work except the one being viewed. */
export function seriesRailWorks(
  series: BookMetaSeries,
  currentWorkId: string,
): BookMetaSeriesWork[] {
  return series.works.filter((w) => w.id !== currentWorkId);
}

/** Open an external meta URL. Mirrors src/lib/support.ts: a real new tab on web
 * (Linking → window.open), an in-app Custom Tab on native. */
async function openExternal(url: string): Promise<void> {
  try {
    if (Platform.OS === 'web') await Linking.openURL(url);
    else await WebBrowser.openBrowserAsync(url);
  } catch {
    // user dismissed it, or no browser is available - nothing to recover from
  }
}

/**
 * Enriched community metadata for a book (description, production details, and a
 * "more in this series" rail), shown beneath the file/chapter list on the book
 * screen. Progressive enhancement: the caller gates this on the server's
 * `metadata` capability, and the component itself renders nothing while loading,
 * on error, or when the service returns no match - so the page never regresses
 * when metadata is unavailable.
 */
export function BookMetaSection({ libraryId, path }: { libraryId: number; path: string }) {
  // The caller only mounts this under a metadata-capable server, so gate the query
  // on `true` here (the hook still guards on a resolvable client + non-empty path).
  const { data } = useBookMeta(libraryId, path, true);

  if (!data || !data.matched) return null;
  return <MatchedMeta meta={data} />;
}

function MatchedMeta({ meta }: { meta: Extract<BookMeta, { matched: true }> }) {
  const { t } = useTranslation();
  const { work, recording, series, web_url } = meta;
  const [expanded, setExpanded] = useState(false);

  const description = work.description?.trim() ?? '';
  const canCollapse = descriptionIsLong(description);

  // Compact detail rows. Narrator + runtime are shown elsewhere on the screen, so
  // they are intentionally omitted here.
  const details: { label: string; value: string }[] = [];
  if (recording?.publisher)
    details.push({ label: t('book.meta.publisher'), value: recording.publisher });
  if (recording?.release_date)
    details.push({ label: t('book.meta.released'), value: recording.release_date });
  if (work.first_published)
    details.push({ label: t('book.meta.firstPublished'), value: work.first_published });

  const rails = (series ?? [])
    .map((s) => ({ series: s, works: seriesRailWorks(s, work.id) }))
    .filter((r) => r.works.length > 0);
  const multipleSeries = rails.length > 1;

  const hasAbout = description.length > 0 || details.length > 0 || recording?.abridged === true;

  return (
    <View className="gap-6">
      {hasAbout ? (
        <View className="gap-2">
          <SectionHeader title={t('book.meta.about')} />
          {description.length > 0 ? (
            <View className="gap-1">
              <Text variant="body" numberOfLines={expanded || !canCollapse ? undefined : 6}>
                {description}
              </Text>
              {canCollapse ? (
                <AnimatedPressable
                  onPress={() => setExpanded((v) => !v)}
                  hitSlop={8}
                  accessibilityRole="button"
                  className="flex-row items-center gap-1 self-start py-0.5"
                >
                  <Text className="text-sm font-roboto-medium text-primary">
                    {expanded ? t('book.meta.showLess') : t('book.meta.showMore')}
                  </Text>
                  <Icon
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={12}
                    color={colors.primary}
                  />
                </AnimatedPressable>
              ) : null}
            </View>
          ) : null}
          {details.length > 0 || recording?.abridged === true ? (
            <View className="mt-1 gap-1.5">
              {details.map((d) => (
                <View key={d.label} className="flex-row gap-2">
                  <Text variant="muted" className="w-32">
                    {d.label}
                  </Text>
                  <Text variant="subtitle" className="flex-1">
                    {d.value}
                  </Text>
                </View>
              ))}
              {recording?.abridged === true ? (
                <View className="mt-0.5 self-start rounded-full bg-primary/10 px-2.5 py-1 dark:bg-primary/15">
                  <Text className="text-xs font-roboto-medium text-primary dark:text-primary-400">
                    {t('book.meta.abridged')}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {rails.map(({ series: s, works }) => (
        <View key={s.id} className="gap-2">
          <SectionHeader
            title={
              multipleSeries
                ? t('book.meta.moreInNamedSeries', { series: s.name })
                : t('book.meta.moreInSeries')
            }
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-3 pb-1"
          >
            {works.map((w) => (
              <AnimatedPressable
                key={w.id}
                onPress={() => void openExternal(w.web_url)}
                accessibilityRole="link"
                accessibilityLabel={w.title}
                className="w-28"
              >
                <View className="overflow-hidden rounded-lg border border-black/10 shadow-sm dark:border-white/10 dark:shadow-none">
                  <Cover source={w.cover_url ?? null} label={w.title} />
                </View>
                {w.position ? (
                  <Text variant="caption" className="mt-1.5">
                    {t('book.meta.seriesPosition', { position: w.position })}
                  </Text>
                ) : null}
                <Text variant="subtitle" numberOfLines={2} className="mt-0.5">
                  {w.title}
                </Text>
              </AnimatedPressable>
            ))}
          </ScrollView>
        </View>
      ))}

      <AnimatedPressable
        onPress={() => void openExternal(web_url)}
        accessibilityRole="link"
        className="flex-row items-center gap-2 self-start py-1"
      >
        <Icon name="library" size={14} color={colors.primary} />
        <Text className="text-sm font-roboto-medium text-primary">{t('book.meta.viewOnMeta')}</Text>
        <Icon name="chevron-right" size={12} color={colors.primary} />
      </AnimatedPressable>
    </View>
  );
}
