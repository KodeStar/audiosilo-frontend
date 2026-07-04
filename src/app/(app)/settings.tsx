import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';

import { ConnectionsSection } from '@/components/account/connections-section';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Stepper } from '@/components/ui/stepper';
import { Text } from '@/components/ui/text';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { useLanguage, type LanguagePref } from '@/i18n/language-provider';
import { isSupportAvailable, openSupport } from '@/lib/support';
import { APP_VERSION } from '@/lib/version';
import { useSettings } from '@/stores/settings';
import { useTheme, type SchemePref } from '@/theme/theme-provider';

const APPEARANCE: SchemePref[] = ['light', 'dark', 'system'];

const sec = (v: number) => `${v}s`;
const speed = (v: number) => `${Number(v.toFixed(2))}×`;
const mins = (v: number) => `${Math.round(v / 60)}m`;

// App-level preferences only. Account management (password, recovery, device
// pairing, sign-out, server version) is per-connection and lives on each
// connection's account screen, reached from the Servers list below.
export default function SettingsScreen() {
  const { t } = useTranslation();
  const { pref, setPref } = useTheme();
  const { pref: langPref, setPref: setLangPref } = useLanguage();

  // System default first, then each catalog in its own endonym (not translated).
  const languages: { value: LanguagePref; label: string }[] = [
    { value: 'system', label: t('settings.language.system') },
    ...SUPPORTED_LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
  ];
  const secOrOff = (v: number) => (v === 0 ? t('settings.playback.off') : `${v}s`);

  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const defaultRate = useSettings((s) => s.defaultRate);
  const autoRewindMax = useSettings((s) => s.autoRewindMax);
  const virtualChapterInterval = useSettings((s) => s.virtualChapterInterval);
  const setSkipForward = useSettings((s) => s.setSkipForward);
  const setSkipBackward = useSettings((s) => s.setSkipBackward);
  const setDefaultRate = useSettings((s) => s.setDefaultRate);
  const setAutoRewindMax = useSettings((s) => s.setAutoRewindMax);
  const setVirtualChapterInterval = useSettings((s) => s.setVirtualChapterInterval);

  const paddingBottom = useMiniPlayerInset();

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-6 p-4 lg:px-8"
      contentContainerStyle={{ paddingBottom }}
    >
      <Text variant="heading">{t('settings.title')}</Text>

      <ConnectionsSection />

      <View className="gap-2">
        <Text variant="label">{t('settings.appearance.label')}</Text>
        <Card className="flex-row gap-2 p-2">
          {APPEARANCE.map((value) => {
            const active = pref === value;
            return (
              <Pressable
                key={value}
                onPress={() => setPref(value)}
                className={`flex-1 items-center rounded-md px-3 py-2 ${active ? 'bg-primary' : 'bg-gray-100 dark:bg-gray-860'}`}
              >
                <Text
                  className={`font-roboto-medium ${active ? 'text-white dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}
                >
                  {t(`settings.appearance.${value}`)}
                </Text>
              </Pressable>
            );
          })}
        </Card>
      </View>

      <View className="gap-2">
        <Text variant="label">{t('settings.language.label')}</Text>
        <Card className="flex-row flex-wrap gap-2 p-2">
          {languages.map((o) => {
            const active = langPref === o.value;
            return (
              <Pressable
                key={o.value}
                onPress={() => setLangPref(o.value)}
                className={`items-center rounded-md px-3 py-2 ${active ? 'bg-primary' : 'bg-gray-100 dark:bg-gray-860'}`}
              >
                <Text
                  className={`font-roboto-medium ${active ? 'text-white dark:text-white' : 'text-gray-600 dark:text-gray-400'}`}
                >
                  {o.label}
                </Text>
              </Pressable>
            );
          })}
        </Card>
      </View>

      <View className="gap-2">
        <Text variant="label">{t('settings.playback.label')}</Text>
        <Card className="gap-4">
          <View className="flex-row items-center justify-between">
            <Text>{t('settings.playback.skipBack')}</Text>
            <Stepper
              value={skipBackward}
              onChange={setSkipBackward}
              step={5}
              min={5}
              max={120}
              format={sec}
            />
          </View>
          <View className="flex-row items-center justify-between">
            <Text>{t('settings.playback.skipForward')}</Text>
            <Stepper
              value={skipForward}
              onChange={setSkipForward}
              step={5}
              min={5}
              max={120}
              format={sec}
            />
          </View>
          <View className="flex-row items-center justify-between">
            <Text>{t('settings.playback.defaultSpeed')}</Text>
            <Stepper
              value={defaultRate}
              onChange={setDefaultRate}
              step={0.05}
              min={0.5}
              max={2}
              format={speed}
            />
          </View>
          <View className="flex-row items-center justify-between">
            <Text>{t('settings.playback.autoRewind')}</Text>
            <Stepper
              value={autoRewindMax}
              onChange={setAutoRewindMax}
              step={5}
              min={0}
              max={30}
              format={secOrOff}
            />
          </View>
          <View className="flex-row items-center justify-between">
            <Text>{t('settings.playback.chapterLength')}</Text>
            <Stepper
              value={virtualChapterInterval}
              onChange={setVirtualChapterInterval}
              step={300}
              min={300}
              max={3600}
              format={mins}
            />
          </View>
        </Card>
      </View>

      {/* Support is web/Android only - Apple disallows linking out to an external
          developer-donation page, and the UK App Store is outside the US/EU
          carve-outs that now permit it (see src/lib/support.ts). */}
      {isSupportAvailable() ? (
        <View className="gap-2">
          <Text variant="label">{t('settings.support.label')}</Text>
          <Card className="gap-3">
            <Text variant="muted">{t('settings.support.intro')}</Text>
            <Button
              title={t('settings.support.cta')}
              icon="heart"
              variant="secondary"
              onPress={() => void openSupport()}
            />
          </Card>
        </View>
      ) : null}

      <Text variant="caption" className="text-center">
        {t('settings.version', { version: APP_VERSION })}
      </Text>
    </ScrollView>
  );
}
