import { Fragment } from 'react';

import { WithActiveModules } from '@/modules/active-modules';
import type { PlayerModule } from '@/modules/registry';
import type { Connection } from '@/stores/session';

/**
 * Home's module rails (Bridge Phase 2a): each active module's `homeRails`, in registry
 * order, for the person listening's servers. Renders nothing without one (the registry is
 * empty until Phase 2b).
 */
export function ModuleRails({
  connections,
  modules,
}: {
  connections: Connection[];
  modules?: readonly PlayerModule[];
}) {
  return (
    <WithActiveModules modules={modules}>
      {(active) =>
        active.map((m) =>
          m.homeRails ? <Fragment key={m.id}>{m.homeRails({ connections })}</Fragment> : null,
        )
      }
    </WithActiveModules>
  );
}
