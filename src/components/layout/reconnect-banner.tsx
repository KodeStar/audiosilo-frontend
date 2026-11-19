import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable } from 'react-native';

import { effectiveUrl } from '@/api/address-route';
import { holdReconnect } from '@/components/connect/invite-handoff';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { currentNavState, focusedRoute } from '@/lib/root-stack';
import { cn } from '@/lib/utils';
import { useProfileConnections } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';
import { useThemeColors } from '@/theme/use-theme-colors';

/** The brand strip a reconnect line sits on (the banner, kids mode's signed-out line). */
export const RECONNECT_STRIP_CLASS = 'border-l-4 border-l-brand bg-brand/10';

/** The shell's slim bars' layout under the header (this banner, `ProxyRefusedBanner`). */
export const BANNER_STRIP_CLASS = 'flex-row items-center gap-2 border-b border-b-border px-3 py-2';

/** The connect flow's sign-in step, as the router names it (`src/app/connect/sign-in.tsx`). */
const SIGN_IN_ROUTE = 'sign-in';

/** The reconnect on its way (`reconnectConnection`), so a second tap joins it. */
let reconnecting: Promise<void> | null = null;

/** How long a pushed sign-in step can take to show on the stack. expo-router only queues a
 * push and applies it in a later render (a transition, which a tap interrupts), so for a
 * moment the stack says nothing of the step on its way. Bounded: a push that never lands
 * cannot hold Reconnect back. */
const PUSH_LANDS_MS = 1000;
/** When the sign-in step was last pushed (`Date.now()`), or null. */
let pushedAt: number | null = null;

/** Start the reconnect flow for `conn`: the sign-in step for its server, through the
 * address the connection uses NOW (`effectiveUrl`; away from home that is its away
 * address, not the home address it may have been paired with, which can't answer).
 * Signing in keeps the connection's own `serverUrl` (`repairPlan`). The connection it
 * re-pairs is handed over in memory (`holdReconnect`). One at a time: a double tap while
 * one is on its way, while its pushed step has yet to reach the stack, or once that step is
 * on screen, pushes no second step. */
export function reconnectConnection(conn: Connection): Promise<void> {
  const state = currentNavState();
  if (focusedRoute(state)?.name === SIGN_IN_ROUTE) return Promise.resolve();
  // Only against a stack that can be read: with none there is no push to wait for.
  if (state && pushedAt !== null && Date.now() - pushedAt < PUSH_LANDS_MS) return Promise.resolve();
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
  pushedAt = Date.now();
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
      className={cn(BANNER_STRIP_CLASS, 'active:opacity-80', RECONNECT_STRIP_CLASS, className)}
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

/** "Sign in again" for `conn` beside a proxy's refusal (`ProxyRefusedBanner`, the Account
 * page's Proxy headers card): this banner's flow (`reconnectConnection`), named for its
 * server. A server known to mark its 401s has every unmarked one read as a refusal
 * (WS-401-MARK), so a real revoke behind a proxy that drops the mark is answered here. */
export function SignInAgainButton({
  conn,
  ...style
}: { conn: Connection } & Pick<ButtonProps, 'variant' | 'size' | 'className'>) {
  const { t } = useTranslation();
  return (
    <Button
      {...style}
      title={t('profiles.signIn.action')}
      accessibilityLabel={t('reconnect.state.title', { name: conn.name })}
      onPress={() => void reconnectConnection(conn)}
    />
  );
}
