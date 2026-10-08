import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useActiveAddress } from '@/api/address-route';
import { useMyDevices, useServerAddresses, useServerInfo } from '@/api/hooks';
import type { Capabilities } from '@/api/types';
import { AddressesCard } from '@/components/layout/addresses-card';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { cleanAddresses, hostOf } from '@/lib/pairing';
import { addressKind, mergeAddresses } from '@/lib/server-address';
import { APP_VERSION } from '@/lib/version';
import { useSession } from '@/stores/session';

import { resolveAccountCid, signedInSessions } from './account-model';
import { ApiKeyCreatedModal } from './api-key-created-modal';
import { ApiKeysSection, ApiKeysUnavailable } from './api-keys-section';
import { DevicesSection } from './devices-section';
import { IdentityCard } from './identity-card';
import { PairDeviceCard } from './pair-device-card';
import { PasswordCard, PasswordDialog } from './password-card';
import { SignOutConfirm } from './sign-out-confirm';
import { useApiKeysManager } from './use-api-keys-manager';
import { usePasswordEditor } from './use-password-editor';
import { useSignOut } from './use-sign-out';

/** Below this measured width the identity card puts the device count on its own line
 * (a wrapped "· signed in on 4 devices" would start a line with the separator). */
const IDENTITY_ONE_LINE_MIN = 560;

/** The narrowest measured column that takes the password and pairing cards side by side
 * (two ~330 cards). Measured, not the window class: the Up next drawer can take 300-480
 * of a desktop. */
const CARDS_BESIDE_MIN = 680;

/**
 * One server's account page body (the Stacks prototype's `Account`): who is signed in,
 * the password, pairing another device, the signed-in devices, personal API keys and
 * signing out. Every block is gated on its capability, so an older server shows less,
 * quietly.
 *
 * - `/account?connection=<cid>` passes its `connectionId`: that server only.
 * - The phone You hub's Account segment passes none: the default server, with a
 *   switcher (a segmented control of the signed-in servers) when there are several.
 *
 * It is a plain column (no ScrollView): the host scrolls it, and keeps the mini-player
 * inset. The dialogs portal to the root.
 */
export function AccountSection({ connectionId }: { connectionId?: string }) {
  const { t } = useTranslation();
  const connections = useSession((s) => s.connections);
  const defaultId = useSession((s) => s.defaultConnectionId);
  const [picked, setPicked] = useState<string | null>(null);
  const cid = resolveAccountCid(
    connectionId,
    picked,
    connections.map((c) => c.id),
    defaultId,
  );
  const connection = connections.find((c) => c.id === cid) ?? null;

  if (!cid || !connection) {
    return (
      <View className="w-full max-w-[880px] self-center">
        <Card>
          <Text variant="muted">{t('account.none')}</Text>
        </Card>
      </View>
    );
  }

  const switcher =
    !connectionId && connections.length > 1 ? (
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1.5">
        <SegmentedControl
          scrollable
          accessibilityLabel={t('account.switcher')}
          options={connections.map((c) => ({ value: c.id, label: c.name }))}
          value={cid}
          onChange={setPicked}
          className="max-w-full self-start"
        />
        <Text variant="caption" numberOfLines={1} className="shrink">
          {hostOf(connection.serverUrl)}
        </Text>
      </View>
    ) : null;

  // Keyed by the server, so a switch starts with closed editors and no other server's
  // pairing code or half-typed password.
  return <AccountBody key={cid} cid={cid} switcher={switcher} />;
}

function AccountBody({ cid, switcher }: { cid: string; switcher: ReactNode }) {
  const { t } = useTranslation();
  const connection = useSession((s) => s.connections.find((c) => c.id === cid) ?? null);
  const user = connection?.user ?? null;
  const serverName = connection?.name ?? '';
  const { data: server } = useServerInfo(cid);
  const caps = server?.capabilities;
  const demo = !!user?.is_demo;

  // Side by side where the measured column fits both (assumed until it is measured, off
  // a phone, so a desktop doesn't flash a single column first).
  const phone = useLayout() === 'phone';
  const [width, setWidth] = useState(0);
  const beside = !phone && (width === 0 || width >= CARDS_BESIDE_MIN);
  const identityStacked = width === 0 ? phone : width < IDENTITY_ONE_LINE_MIN;

  // Signed-in sessions for the identity line (the same query the devices list reads).
  const devices = useMyDevices(cid);
  const deviceCount = devices.data ? signedInSessions(devices.data).length : undefined;

  const password = usePasswordEditor(cid);
  // The guarded sign-out, scoped to this connection: the only way this device signs out
  // (never `useRevokeMyDevice` on its own row).
  const signOut = useSignOut(cid);

  // API keys: only where the server advertises them, and never for demo accounts (the
  // server refuses them). The manager runs unconditionally; `apiKeysEnabled` gates its
  // list query and the section.
  const apiKeysEnabled = caps?.api_keys === true && !demo;
  const apiKeys = useApiKeysManager(cid, apiKeysEnabled);

  return (
    <View
      className="w-full max-w-[880px] gap-6 self-center"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {switcher}

      <IdentityCard
        user={user}
        serverName={serverName}
        deviceCount={deviceCount}
        stacked={identityStacked}
      />

      <View className={beside ? 'flex-row items-stretch gap-4' : 'gap-4'}>
        {/* Demo accounts can't set a password (the server refuses it). */}
        {!demo ? <PasswordCard editor={password} className={cn(beside && 'flex-1')} /> : null}
        <PairDeviceCard
          connectionId={cid}
          serverName={serverName}
          className={cn(beside && 'flex-1')}
        />
      </View>

      <AccountAddresses cid={cid} caps={caps} />

      {caps?.my_devices === true ? (
        <DevicesSection connectionId={cid} serverName={serverName} />
      ) : null}

      {demo ? null : apiKeysEnabled ? (
        <ApiKeysSection manager={apiKeys} />
      ) : caps?.api_keys === false ? (
        <ApiKeysUnavailable serverName={serverName} />
      ) : null}

      <Card className="flex-row flex-wrap items-center justify-between gap-4 border-destructive/35">
        <View className="min-w-[180px] flex-1 gap-0.5">
          <Text variant="title" accessibilityRole="header">
            {t('account.danger.title', { server: serverName })}
          </Text>
          <Text variant="muted">{t('account.danger.body')}</Text>
        </View>
        <Button
          variant="destructive-outline"
          icon="logout"
          title={t('settings.account.signOut')}
          accessibilityLabel={t('account.danger.title', { server: serverName })}
          onPress={() => void signOut.requestSignOut()}
        />
      </Card>

      <Text variant="caption" className="text-center">
        {t('settings.version', { version: server?.version ?? APP_VERSION })}
      </Text>

      <PasswordDialog editor={password} />
      <SignOutConfirm
        visible={signOut.confirmVisible}
        connectionId={cid}
        onCancel={() => signOut.setConfirmVisible(false)}
        onSignOut={signOut.signOut}
        onSetPassword={() => {
          // Dismiss the warning and open this connection's set-password editor: the
          // durable, self-service way back in after signing out.
          signOut.setConfirmVisible(false);
          password.openEditor();
        }}
      />
      <ApiKeyCreatedModal created={apiKeys.created} onClose={apiKeys.dismissCreated} />
      <ConfirmDialog
        visible={apiKeys.pendingRevoke !== null}
        title={t('settings.apiKeys.revokeConfirm.title', {
          name: apiKeys.pendingRevoke?.label ?? '',
        })}
        message={t('settings.apiKeys.revokeConfirm.message')}
        confirmLabel={t('settings.apiKeys.revokeConfirm.confirm')}
        confirmIcon="trash"
        destructive
        onConfirm={apiKeys.confirmRevoke}
        onCancel={apiKeys.cancelRevoke}
      />
    </View>
  );
}

/**
 * "At home and away" (capability `addresses`): this server's home and away addresses,
 * what the device keeps (`connection.addresses`, which the native address runner
 * refreshes) merged with what the server says now (`useServerAddresses`; on the web it
 * is the only refresh), and on native which one this device is using now. Web never
 * switches (the served player stays on its own origin), so it shows no "in use" line.
 * Nothing for a server without the capability or with no address to show.
 */
function AccountAddresses({ cid, caps }: { cid: string; caps: Capabilities | undefined }) {
  const { t } = useTranslation();
  const kept = useSession((s) => s.connections.find((c) => c.id === cid)?.addresses);
  const { data: fresh } = useServerAddresses(cid);
  const active = useActiveAddress(cid);
  if (caps?.addresses !== true) return null;
  const addresses = mergeAddresses(kept, cleanAddresses(fresh));
  if (!addresses) return null;
  // Named against what the card shows (the server may have just told us an address the
  // device hasn't stored yet).
  const inUse = addressKind(active.url, { id: cid, serverUrl: active.url, addresses });
  return (
    <AddressesCard
      addresses={addresses}
      body={t('addresses.body')}
      inUse={Platform.OS === 'web' ? undefined : inUse}
    />
  );
}
