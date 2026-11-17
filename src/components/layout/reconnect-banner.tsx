import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable } from 'react-native';

import { effectiveUrl } from '@/api/address-route';
import { holdReconnect } from '@/components/connect/invite-handoff';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { currentNavState, focusedRoute } from '@/lib/root-stack';
import { cn } from '@/lib/utils';
import { useProfileConnections } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';
import { useThemeColors } from '@/theme/use-theme-colors';

/** The brand strip a reconnect line sits on (the banner, kids mode's signed-out line). */
export const RECONNECT_STRIP_CLASS = 'border-l-4 border-l-brand bg-brand/10';

/** The connect flow's sign-in step, as the router names it (`src/app/connect/sign-in.tsx`). */
const SIGN_IN_ROUTE = 'sign-in';

/** The reconnect on its way (`reconnectConnection`), so a second tap joins it. */
let reconnecting: Promise<void> | null = null;

/** Start the reconnect flow for `conn`: the sign-in step for its server, through the
 * address the connection uses NOW (`effectiveUrl`; away from home that is its away
 * address, not the home address it may have been paired with, which can't answer).
 * Signing in keeps the connection's own `serverUrl` (`repairPlan`). The connection it
 * re-pairs is handed over in memory (`holdReconnect`). One at a time: a double tap while
 * one is on its way, or once its sign-in step is on screen, pushes no second step. */
export function reconnectConnection(conn: Connection): Promise<void> {
  if (focusedRoute(currentNavState())?.name === SIGN_IN_ROUTE) return Promise.resolve();
  reconnecting ??= startReconnect(conn).finally(() => {
    reconnecting = null;
  });
  return reconnecting;
}

async function startReconnect(conn: Connection): Promise<void> {
  const server = effectiveUrl(conn);
  await useSession.getState().setPendingServerUrl(server);
  // Which connection the sign-in re-pairs goes in memory, never in the route (fe#298).
  holdReconnect(server, conn.id);
  router.push({ pathname: '/connect/sign-in', params: { serverName: conn.name } });
}

/**
 * The person listening's connections whose sign-in ended (`needsReconnect`: a 401 on any
 * request, or a server reset), in connection order: the banner's list, and the one a
 * screen whose load failed for them checks to show `SignInAgainState` in place of its
 * load error and its empty state (frontend#124): asking again cannot help, signing in
 * again does. Another person's sign-in is theirs to renew, so only this profile's.
 */
export function useSignedOutConnections(): Connection[] {
  return useProfileConnections().filter((c) => c.needsReconnect);
}

/**
 * Slim, accent-bordered bar shown when a connection's token is being rejected (or its
 * server was reset), so the user is never silently stuck on dead requests. Tapping it
 * starts the reconnect flow for that server: it pre-fills the address the connection uses
 * now (`effectiveUrl`) via `pendingServerUrl` and opens the sign-in step for it, where the
 * user just re-enters a code or password. A successful re-pair calls `setSession`, which
 * clears the flag (and refreshes the known-servers list).
 *
 * When more than one connection needs reconnecting we surface the first (with a "+N"),
 * keeping the chrome unobtrusive.
 */
export function ReconnectBanner({ className }: { className?: string } = {}) {
  const themed = useThemeColors();
  const { t } = useTranslation();
  const needing = useSignedOutConnections();

  if (needing.length === 0) return null;
  const conn = needing[0];
  const extra = needing.length - 1;

  const label =
    conn.needsReconnect === 'server-reset'
      ? t('reconnect.banner.serverReset', { name: conn.name })
      : t('reconnect.banner.auth', { name: conn.name });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={t('reconnect.banner.hint')}
      onPress={() => void reconnectConnection(conn)}
      className={cn(
        'flex-row items-center gap-2 border-b border-b-border px-3 py-2 active:opacity-80',
        RECONNECT_STRIP_CLASS,
        className,
      )}
    >
      <Icon name="server" size={13} color={themed.brand} />
      <Text variant="caption" className="flex-1 text-brand-ink">
        {label}
        {extra > 0 ? ` ${t('reconnect.banner.more', { count: extra })}` : ''}
      </Text>
      <Icon name="chevron-right" size={13} color={themed.brand} />
    </Pressable>
  );
}
