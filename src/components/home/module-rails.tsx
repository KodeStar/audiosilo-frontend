import { useMemo } from 'react';

import { useCapabilitiesAll } from '@/api/hooks';
import { WithActiveModules } from '@/modules/active-modules';
import type { ModuleFlag, PlayerModule } from '@/modules/registry';
import type { Connection } from '@/stores/session';

/**
 * Home's module rails (Bridge Phase 2a): each active module's `homeRails`, in registry
 * order, for the person listening's servers that have the module on (a rail never has to
 * filter them itself, fe#159). Renders nothing without one (the registry is empty until a
 * module has a player part), and reads no flags then (`WithActiveModules`).
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
          m.homeRails ? (
            <Rails key={m.id} id={m.id} rails={m.homeRails} connections={connections} />
          ) : null,
        )
      }
    </WithActiveModules>
  );
}

/** One module's rails behind a component of their own, so a hook reached through them
 * stays theirs as the active list changes. Given only the connections whose server has the
 * module on (`id`, its flag). */
function Rails({
  id,
  rails,
  connections,
}: {
  id: ModuleFlag;
  rails: NonNullable<PlayerModule['homeRails']>;
  connections: Connection[];
}) {
  const caps = useCapabilitiesAll();
  const on = useMemo(() => connections.filter((c) => !!caps[c.id]?.[id]), [connections, caps, id]);
  return rails({ connections: on });
}
