import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, ScrollView, View } from 'react-native';

import { ApiError } from '@/api/client';
import { useServerInfo } from '@/api/hooks';
import { useOptionalApi, useScopedCid } from '@/api/provider';
import type { PairingPayload } from '@/api/types';
import { RecoveryCodeModal } from '@/components/account/recovery-code-modal';
import { SignOutConfirm } from '@/components/account/sign-out-confirm';
import { useRecoveryCode } from '@/components/account/use-recovery-code';
import { useSignOut } from '@/components/account/use-sign-out';
import { ContentScope } from '@/components/layout/content-scope';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { BreadCrumbs, type Crumb } from '@/components/ui/breadcrumbs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { shareText } from '@/lib/share';
import { APP_VERSION } from '@/lib/version';
import { colors } from '@/theme/tokens';
import { useSession } from '@/stores/session';

const PW_MIN = 8;

/**
 * Per-connection account screen (`/account?connection=<cid>`). The `(app)` layout reads
 * that query param and publishes the connection scope, so `useOptionalApi()`/
 * `useServerInfo()`/the account hooks all resolve to *this* server - managing one
 * connection's account never touches another's. Reached from the Settings → Servers
 * list. Settings itself keeps only app-level preferences.
 *
 * The `?connection=` scope comes from this route's OWN local param (reliable on a cold
 * deep link); the body reads it via `useScopedCid()`, so it's a child of `<ContentScope>`.
 */
export default function AccountScreen() {
  return (
    <ContentScope>
      <AccountContent />
    </ContentScope>
  );
}

function AccountContent() {
  const { t } = useTranslation();
  const cid = useScopedCid();
  const api = useOptionalApi();
  const { data: server } = useServerInfo();
  // This connection's user/URL (not the ambient active mirror) - the scope layout has
  // already redirected home if the id isn't a known connection, so it exists here.
  const connection = useSession((s) => s.connections.find((c) => c.id === cid) ?? null);
  const user = connection?.user ?? null;
  const serverUrl = connection?.serverUrl ?? null;
  const setConnectionUser = useSession((s) => s.setConnectionUser);

  const paddingBottom = useMiniPlayerInset();

  // Set/change a password - the conventional way back in after a sign-out. A new
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
        void setConnectionUser(cid, await api.me());
      } catch {
        // ignore - the password change succeeded regardless
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

  // Recovery code + guarded sign-out, both scoped to this connection.
  const recovery = useRecoveryCode(cid);
  const signOut = useSignOut(cid);

  // Self-service device pairing: mint a fresh pairing QR for this account so
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

  const crumbs: Crumb[] = [
    { label: t('settings.title'), onPress: () => router.back() },
    { label: connection?.name ?? t('settings.account.label'), active: true },
  ];

  return (
    <>
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-6 p-4 lg:px-8"
        contentContainerStyle={{ paddingBottom }}
      >
        <BreadCrumbs crumbs={crumbs} />

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
                    <Text className="text-xs text-danger-600 dark:text-danger">
                      {recovery.error}
                    </Text>
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

            <AnimatedPressable
              accessibilityRole="button"
              accessibilityLabel={t('settings.account.signOut')}
              onPress={() => void signOut.requestSignOut()}
              className="flex-row items-center justify-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 active:bg-danger/10"
            >
              <Icon name="logout" size={16} color={colors.danger} />
              <Text className="font-roboto-semibold text-base text-danger-600 dark:text-danger">
                {t('settings.account.signOut')}
              </Text>
            </AnimatedPressable>
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
                  className="self-center rounded-xl bg-white p-3"
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
                {pairError ? (
                  <Text className="text-sm text-danger-600 dark:text-danger">{pairError}</Text>
                ) : null}
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
            version: server?.version ?? APP_VERSION,
          })}
        </Text>
      </ScrollView>

      <SignOutConfirm
        visible={signOut.confirmVisible}
        connectionId={cid}
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
