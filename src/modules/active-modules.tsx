import type { ReactNode } from 'react';

import {
  NO_MODULES,
  PLAYER_MODULES,
  type PlayerModule,
  useActiveModules,
  useModulesOn,
} from './registry';

type Props = {
  /** The modules to choose from (the registry; tests pass a fake). */
  modules?: readonly PlayerModule[];
  /** Only this connection's server counts (a book's own); absent, any of the person's. */
  connectionId?: string;
  children: (active: readonly PlayerModule[]) => ReactNode;
};

/**
 * A slot's modules: `children` gets the ones that are on. With no modules to choose from
 * (the registry is empty in Phase 2a) it asks nothing and reads no server, so the slot
 * renders exactly as it would without modules.
 */
export function WithActiveModules({ modules = PLAYER_MODULES, connectionId, children }: Props) {
  if (modules.length === 0) return children(NO_MODULES);
  return connectionId === undefined ? (
    <Anywhere modules={modules}>{children}</Anywhere>
  ) : (
    <OnConnection modules={modules} connectionId={connectionId}>
      {children}
    </OnConnection>
  );
}

function Anywhere({ modules, children }: Required<Pick<Props, 'modules' | 'children'>>) {
  return children(useActiveModules(modules));
}

function OnConnection({
  modules,
  connectionId,
  children,
}: Required<Pick<Props, 'modules' | 'connectionId' | 'children'>>) {
  return children(useModulesOn(connectionId, modules));
}
