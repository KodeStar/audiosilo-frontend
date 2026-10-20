import type { TFunction } from 'i18next';
import { useMemo, type ReactNode } from 'react';

import { anyCapability, useCapabilitiesAll, useServerInfo } from '@/api/hooks';
import type { Book, Capabilities } from '@/api/types';
import type { BookAction } from '@/components/library/books/book-actions';
import type { Connection } from '@/stores/session';

/** The capability flags that are modules' (each mirrored in {@link Capabilities} like every
 * other flag): never a core flag such as `queue` or `bridge`, as the server refuses a module
 * named after one. A new module's flag is added here too. */
export type ModuleFlag = Extract<keyof Capabilities, 'contributions'>;

/**
 * The player's modules (Bridge Phase 2a): optional features a server module brings, each
 * shown only where a server advertises its capability flag. A server module ships off;
 * an admin turns it on in the console (Settings > Modules), and its flag reads true only
 * while it is on AND its Bridge requirement is met. NOT the repo-root `modules/` (the
 * native Expo modules, such as `modules/audiosilo-player`): a different thing.
 *
 * A module plugs into the player's slots, each optional:
 * - `homeRails`: Home, once after Next in your series (`ModuleRails`).
 * - `youSections`: the You hub, after Account on a phone and after Journal in the wide
 *   sub-nav. `key` is the `?section=` value (a core section's name is ignored), `label` its
 *   segment and title (a function of `t`, so it follows the language), `render` a plain
 *   column the hub scrolls.
 * - `bookActions`: items in the book page's menu (`HeroActions`), for a book on a server
 *   that has the flag. A plain function of its props, never a hook: the active list
 *   changes as servers answer.
 *
 * The slots return elements; a slot's hooks live in the components it returns (the slots
 * call `homeRails` and `render` behind a component of their own all the same, so a hook
 * reached through one stays that module's as the active list changes). A module's book
 * actions are keyed `<id>:<key>` in the menu, so they never clash with the menu's own. The book
 * page's tabs (`BookTab`), the book menu's own keys (`BookActionKey`) and Settings'
 * sections (`SettingsSection`) stay closed until a module needs them (Phase 2d).
 */
export type PlayerModule = {
  /** The module's id: its capability flag on `GET /server` (`capabilities.<id>`). */
  id: ModuleFlag;
  homeRails?: (p: { connections: Connection[] }) => ReactNode;
  youSections?: readonly YouModuleSection[];
  bookActions?: (p: { connectionId: string; book: Book }) => BookAction[];
};

/** A module's section of the You hub. */
export type YouModuleSection = {
  key: string;
  label: (t: TFunction) => string;
  render: (o: { phone: boolean }) => ReactNode;
};

/** The player's modules, in the order their slots show them. Empty: the Contributions
 * module (Bridge Phase 2b) has no player part, as sharing and corrections are console only. */
export const PLAYER_MODULES: readonly PlayerModule[] = [];

/** No modules: one shared empty list, so an unchanged answer keeps its identity. */
export const NO_MODULES: readonly PlayerModule[] = [];

/** The modules of `list` some server of `caps` has on (`anyCapability`; one still loading
 * counts as off until it answers). */
export function activeModules(
  list: readonly PlayerModule[],
  caps: Record<string, Capabilities | undefined>,
): readonly PlayerModule[] {
  const active = list.filter((m) => anyCapability(caps, m.id) === true);
  return active.length > 0 ? active : NO_MODULES;
}

/** The modules of `list` that one server (`caps`, undefined while not known) has on. */
export function modulesOn(
  list: readonly PlayerModule[],
  caps: Capabilities | undefined,
): readonly PlayerModule[] {
  const on = caps ? list.filter((m) => !!caps[m.id]) : NO_MODULES;
  return on.length > 0 ? on : NO_MODULES;
}

/** The modules of `list` that some server of the person listening has on (their servers'
 * `/server` reads, shared with `useServerInfo`). */
export function useActiveModules(list: readonly PlayerModule[] = PLAYER_MODULES) {
  const caps = useCapabilitiesAll();
  return useMemo(() => activeModules(list, caps), [list, caps]);
}

/** The modules of `list` that one connection's server has on (a book's actions go to the
 * book's own server). */
export function useModulesOn(connectionId: string, list: readonly PlayerModule[] = PLAYER_MODULES) {
  const caps = useServerInfo(connectionId).data?.capabilities;
  return useMemo(() => modulesOn(list, caps), [list, caps]);
}
