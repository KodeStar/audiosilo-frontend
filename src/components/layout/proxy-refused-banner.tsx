import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { needsProxyNotice, useProxyRefusals } from '@/api/proxy-refusal';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { isKidAccount } from '@/lib/account';
import { useLayout } from '@/lib/layout';
import { pushInShell } from '@/lib/open';
import { accountHref } from '@/lib/paths';
import { canManageProxySet, connectionProxySet, isLimitedAccount } from '@/lib/proxy-headers';
import { currentNavState, focusedRoute, type NavState } from '@/lib/root-stack';
import { cn } from '@/lib/utils';
import { useProfileConnections } from '@/stores/profiles';
import { useSession } from '@/stores/session';
import { useThemeColors } from '@/theme/use-theme-colors';

import { BANNER_STRIP_CLASS, RECONNECT_STRIP_CLASS, SignInAgainButton } from './reconnect-banner';

/** The Account page's route name in the shell's stacks (`src/app/(app)/.../account.tsx`). */
const ACCOUNT_ROUTE = 'account';

/** Whether the page on screen is `connectionId`'s Account page (`accountHref`'s params): the
 * banner stays up there while the headers are edited, and a tap must not stack the page again. */
export function onAccountPage(state: NavState | undefined, connectionId: string): boolean {
  const route = focusedRoute(state);
  const params = (route?.params ?? {}) as Record<string, unknown>;
  return route?.name === ACCOUNT_ROUTE && params.connection === connectionId;
}

/**
 * A slim bar, beside the reconnect banner, while a proxy in front of a server turns this
 * device's requests away (fe#295, `useProxyRefusals`: from the first refusal until the
 * server itself answers again, so once for the whole run, never once per request). It is not a sign-out:
 * the person listening's connection stays signed in, and the way past is the proxy headers.
 * Where they can change them (`canManageProxySet`, the Account card's own rule) it opens the
 * connection's Account page, whose Proxy headers card edits them; a kid's account that may
 * not (someone else here reaches that address through the same set) is told to ask a
 * grown-up instead, with nothing to tap, and a demo account that may not is only told what
 * happened (no grown-up is behind a demo). So is a kid's account that gets in only on the
 * headers typed for its sign-in (`signInProxySets`, the kept set stale), until a grown-up
 * updates the address's set. A connection that needs signing in again shows the reconnect
 * banner only. The first such connection, in connection order. On that connection's Account
 * page already, a tap pushes nothing (`onAccountPage`). A full account's 401 refusal also
 * offers Sign in again (`reconnectConnection`, the reconnect banner's flow): a server known to
 * mark its 401s has every unmarked one read as a refusal (WS-401-MARK), so a real revoke
 * behind a proxy that drops the mark lands here, and signing in again is its way out. A kid's
 * account, which never signs itself in, is told to ask a grown-up to pair it again; a
 * proxy's 403 offers neither (no sign-in gets past it).
 */
export function ProxyRefusedBanner({ className }: { className?: string } = {}) {
  const themed = useThemeColors();
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const refused = useProxyRefusals((s) => s.refused);
  const connections = useSession((s) => s.connections);
  const sets = useSession((s) => s.proxySets);
  const own = useSession((s) => s.signInProxySets);
  const conn = useProfileConnections().find(
    (c) => !c.needsReconnect && needsProxyNotice(c.id, refused, sets, own),
  );
  if (!conn) return null;

  const status = refused[conn.id];
  const canManage =
    status !== undefined && canManageProxySet(conn, connectionProxySet(sets, conn), connections);
  // A 401 may be the server's refusal of the token with its mark dropped (WS-401-MARK): a
  // full account signs in again here, a kid's account (which never signs itself in) is told
  // who can pair it again. A proxy's 403 is no such thing.
  const mayBeSignedOut = status === 401;
  const kid = isKidAccount(conn.user);
  const content = (
    <>
      <Icon name="key" size={13} color={themed.brand} />
      <Text variant="caption" className="flex-1 text-brand-ink">
        {canManage
          ? kid && mayBeSignedOut
            ? t('proxyHeaders.refusedBannerPair', { name: conn.name })
            : t('proxyHeaders.refusedBanner', { name: conn.name })
          : conn.user?.is_demo
            ? t('proxyHeaders.refusedPlain', { name: conn.name })
            : status === undefined
              ? t('proxyHeaders.askGrownUp')
              : mayBeSignedOut
                ? t('proxyHeaders.refusedAskGrownUpPair', { name: conn.name })
                : t('proxyHeaders.refusedAskGrownUp', { name: conn.name })}
      </Text>
    </>
  );

  const strip = cn(BANNER_STRIP_CLASS, RECONNECT_STRIP_CLASS, className);

  if (!canManage) {
    return (
      <View testID="proxy-refused-banner" accessibilityRole="alert" className={strip}>
        {content}
      </View>
    );
  }
  // Never a kid's or a demo's account (which may still manage a set no full account
  // reaches): they sign in some other way.
  const signInAgain = mayBeSignedOut && !isLimitedAccount(conn.user);
  // The whole strip opens Account, its padding too, but for Sign in again beside the words or,
  // on a narrow phone (or a long label: "Voltar a iniciar sessão"), wrapped under them rather
  // than squeezing them into a column a few words wide.
  const toAccount = (
    <Pressable
      testID="proxy-refused-banner"
      accessibilityRole="button"
      accessibilityHint={t('proxyHeaders.refusedBannerHint')}
      onPress={() => {
        if (!onAccountPage(currentNavState(), conn.id)) pushInShell(accountHref(conn.id));
      }}
      className={cn(
        // Inside the strip, the strip's own row and padding: the edges open Account too.
        signInAgain
          ? 'min-w-[200px] flex-1 flex-row items-center gap-2 self-stretch px-3 py-2'
          : strip,
        'active:opacity-80',
      )}
    >
      {content}
      {/* Beside Sign in again on a wide screen, a chevron would read as the button's. */}
      {signInAgain && !phone ? null : <Icon name="chevron-right" size={13} color={themed.brand} />}
    </Pressable>
  );
  if (!signInAgain) return toAccount;
  return (
    <View
      className={cn(
        'flex-row flex-wrap items-center border-b border-b-border',
        RECONNECT_STRIP_CLASS,
        className,
      )}
    >
      {toAccount}
      <SignInAgainButton conn={conn} size="sm" variant="ghost" className="mx-1" />
    </View>
  );
}
