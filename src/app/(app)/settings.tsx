import Constants from 'expo-constants';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Pressable, ScrollView, View } from 'react-native';

import { ApiError } from '@/api/client';
import { useServerInfo } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import type { PairingPayload } from '@/api/types';
import { ConnectionsSection } from '@/components/account/connections-section';
import { RecoveryCodeModal } from '@/components/account/recovery-code-modal';
import { SignOutConfirm } from '@/components/account/sign-out-confirm';
import { useRecoveryCode } from '@/components/account/use-recovery-code';
import { useSignOut } from '@/components/account/use-sign-out';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { Stepper } from '@/components/ui/stepper';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { useLanguage, type LanguagePref } from '@/i18n/language-provider';
import { shareText } from '@/lib/share';
import { useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import { useTheme, type SchemePref } from '@/theme/theme-provider';

const PW_MIN = 8;

const APPEARANCE: SchemePref[] = ['light', 'dark', 'system'];

const sec = (v: number) => `${v}s`;
const speed = (v: number) => `${Number(v.toFixed(2))}×`;

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
  const api = useOptionalApi();
  const { data: server } = useServerInfo();
  const user = useSession((s) => s.user);
  const serverUrl = useSession((s) => s.activeServerUrl);
  const setUser = useSession((s) => s.setUser);

  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const defaultRate = useSettings((s) => s.defaultRate);
  const autoRewindMax = useSettings((s) => s.autoRewindMax);
  const setSkipForward = useSettings((s) => s.setSkipForward);
  const setSkipBackward = useSettings((s) => s.setSkipBackward);
  const setDefaultRate = useSettings((s) => s.setDefaultRate);
  const setAutoRewindMax = useSettings((s) => s.setAutoRewindMax);

  // Set/change a password — the conventional way back in after a sign-out. A new
  // password must be a real one (min 8, matching the server); changing an existing
  // password requires the current one so a stolen session can't silently replace
  // a known password.
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [curPw, setCurPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  const savePassword = async () => {
    if (!api) return;
    if (pw.length < PW_MIN) {
      setPwError(t('settings.account.password.minError', { count: PW_MIN }));
      return;
    }
    setPwError(null);
    setPwBusy(true);
    try {
      // Changing an existing password requires the current one; setting a first
      // password (a password-less account) does not.
      await api.setPassword(pw, user?.has_password ? curPw : undefined);
      // The change has landed; refreshing has_password is best-effort and must not
      // surface as a "could not update the password" error if /me hiccups.
      try {
        void setUser(await api.me());
      } catch {
        // ignore — the password change succeeded regardless
      }
      setPw('');
      setCurPw('');
      setPwOpen(false);
    } catch (e) {
      setPwError(e instanceof ApiError ? e.message : t('settings.account.password.updateError'));
    } finally {
      setPwBusy(false);
    }
  };

  // Recovery code + guarded sign-out share their logic with the sidebar via hooks.
  const recovery = useRecoveryCode();
  const signOut = useSignOut();
  const paddingBottom = useMiniPlayerInset();

  // Self-service device pairing: mint a fresh pairing QR for the signed-in user so
  // another device can scan it (or open the link) and pair without an admin.
  const [pairing, setPairing] = useState<PairingPayload | null>(null);
  const [pairLoading, setPairLoading] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  const onAddDevice = async () => {
    if (!api) return;
    setPairError(null);
    setPairLoading(true);
    try {
      setPairing(await api.pair());
    } catch (e) {
      setPairError(e instanceof ApiError ? e.message : t('settings.devices.reachError'));
    } finally {
      setPairLoading(false);
    }
  };

  const shareLink = () => {
    if (pairing) void shareText(pairing.web_url);
  };

  return (
    <>
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
          </Card>
        </View>

        <View className="gap-2">
          <Text variant="label">{t('settings.account.label')}</Text>
          <Card className="gap-4">
            <View>
              <Text variant="subtitle">{user?.username ?? t('settings.account.signedIn')}</Text>
              <Text variant="muted">
                {user?.role === 'admin'
                  ? t('settings.account.administrator')
                  : t('settings.account.user')}
                {serverUrl ? ` · ${serverUrl.replace(/^https?:\/\//, '')}` : ''}
              </Text>
            </View>

            {/* Demo accounts can't set a password or mint a recovery code (the
                server refuses both), so hide those affordances entirely. */}
            {!user?.is_demo && (
              <>
                <View className="gap-2">
                  <View className="flex-row items-center justify-between">
                    <Text>{t('settings.account.password.label')}</Text>
                    <Text variant="muted">
                      {user?.has_password
                        ? t('settings.account.password.set')
                        : t('settings.account.password.notSet')}
                    </Text>
                  </View>
                  {pwOpen ? (
                    <View className="gap-2">
                      {user?.has_password ? (
                        <TextField
                          label={t('settings.account.password.current')}
                          placeholder={t('settings.account.password.currentPlaceholder')}
                          secureTextEntry
                          autoCapitalize="none"
                          value={curPw}
                          onChangeText={setCurPw}
                        />
                      ) : null}
                      <TextField
                        label={t('settings.account.password.new')}
                        placeholder={t('settings.account.password.newPlaceholder', {
                          count: PW_MIN,
                        })}
                        secureTextEntry
                        autoCapitalize="none"
                        value={pw}
                        onChangeText={setPw}
                        error={pwError ?? undefined}
                      />
                      <View className="flex-row gap-2">
                        <Button
                          title={t('common.save')}
                          loading={pwBusy}
                          disabled={
                            pw.length < PW_MIN || (!!user?.has_password && curPw.length === 0)
                          }
                          onPress={savePassword}
                        />
                        <Button
                          title={t('common.cancel')}
                          variant="ghost"
                          onPress={() => {
                            setPwOpen(false);
                            setPw('');
                            setCurPw('');
                            setPwError(null);
                          }}
                        />
                      </View>
                    </View>
                  ) : (
                    <Button
                      title={
                        user?.has_password
                          ? t('settings.account.password.change')
                          : t('settings.account.password.setNew')
                      }
                      variant="secondary"
                      onPress={() => setPwOpen(true)}
                    />
                  )}
                </View>

                <View className="gap-2">
                  <View className="flex-row items-center justify-between">
                    <Text>{t('settings.account.recovery.label')}</Text>
                    <Text variant="muted">
                      {user?.has_recovery
                        ? t('settings.account.recovery.set')
                        : t('settings.account.recovery.notSet')}
                    </Text>
                  </View>
                  <Text variant="muted" className="text-xs">
                    {t('settings.account.recovery.hint')}
                  </Text>
                  {recovery.error ? (
                    <Text className="text-xs text-red-500">{recovery.error}</Text>
                  ) : null}
                  <Button
                    title={
                      user?.has_recovery
                        ? t('settings.account.recovery.regenerate')
                        : t('settings.account.recovery.generate')
                    }
                    variant="secondary"
                    icon="qrcode"
                    loading={recovery.busy}
                    onPress={recovery.requestGenerate}
                  />
                </View>
              </>
            )}

            <Button
              title={t('settings.account.signOut')}
              variant="secondary"
              icon="logout"
              onPress={() => void signOut.requestSignOut()}
            />
          </Card>
        </View>

        <View className="gap-2">
          <Text variant="label">{t('settings.devices.label')}</Text>
          <Card className="gap-3">
            {pairing ? (
              <View className="items-center gap-3">
                <Text variant="muted" className="text-center">
                  {t('settings.devices.scanHint')}
                </Text>
                <Image
                  source={{ uri: pairing.qr_png_data_uri }}
                  style={{ width: 220, height: 220 }}
                  className="self-center rounded-lg bg-white p-2"
                />
                <Text selectable variant="muted" className="text-center text-xs">
                  {pairing.web_url}
                </Text>
                <View className="flex-row gap-2">
                  <Button
                    title={t('settings.devices.share')}
                    variant="secondary"
                    icon="qrcode"
                    onPress={shareLink}
                  />
                  <Button
                    title={t('settings.devices.done')}
                    variant="secondary"
                    onPress={() => setPairing(null)}
                  />
                </View>
              </View>
            ) : (
              <>
                <Text variant="muted">{t('settings.devices.intro')}</Text>
                {pairError ? <Text className="text-sm text-red-500">{pairError}</Text> : null}
                {pairLoading ? (
                  <Spinner />
                ) : (
                  <Button title={t('settings.devices.add')} icon="qrcode" onPress={onAddDevice} />
                )}
              </>
            )}
          </Card>
        </View>

        <Text variant="caption" className="text-center">
          {t('settings.version', {
            version: server?.version ?? Constants.expoConfig?.version ?? '1.0.0',
          })}
        </Text>
      </ScrollView>

      <SignOutConfirm
        visible={signOut.confirmVisible}
        onCancel={() => signOut.setConfirmVisible(false)}
        onSignOut={signOut.signOut}
        onSetRecovery={() => {
          signOut.setConfirmVisible(false);
          recovery.requestGenerate();
        }}
      />
      <RecoveryCodeModal code={recovery.code} onClose={() => recovery.setCode(null)} />
      <ConfirmDialog
        visible={recovery.confirmRegen}
        title={t('settings.recoveryReplace.title')}
        message={t('settings.recoveryReplace.message')}
        confirmLabel={t('settings.recoveryReplace.confirm')}
        confirmIcon="qrcode"
        onConfirm={recovery.confirmGenerate}
        onCancel={() => recovery.setConfirmRegen(false)}
      />
    </>
  );
}
