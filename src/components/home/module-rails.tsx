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
          m.homeRails ? <Rails key={m.id} rails={m.homeRails} connections={connections} /> : null,
        )
      }
    </WithActiveModules>
  );
}

/** One module's rails behind a component of their own, so a hook reached through them
 * stays theirs as the active list changes. */
function Rails({
  rails,
  connections,
}: {
  rails: NonNullable<PlayerModule['homeRails']>;
  connections: Connection[];
}) {
  return rails({ connections });
}
