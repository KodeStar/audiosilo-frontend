import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useCapabilitiesAll, useHouseholdMembers } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorNote } from '@/components/ui/query-state';
import { SectionTitle } from '@/components/ui/section-title';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useManagerName, useProfileConnections } from '@/stores/profiles';
import type { Connection } from '@/stores/session';

import { AddMemberDialog } from './add-member-dialog';
import { addBlock } from './household-model';
import { MemberCard } from './member-card';
import { useSetPin } from './use-set-pin';

/**
 * The household members of the person listening (Phase 8b-1): one section per server of
 * theirs that has `household_members` (none at all on older servers: the page is then
 * what Phase 8 shipped). Owns the add dialog and the owner's PIN prompt it can lead to.
 */
export function HouseholdMembers() {
  const connections = useProfileConnections();
  const caps = useCapabilitiesAll();
  const servers = connections.filter((c) => caps[c.id]?.household_members === true);
  const [adding, setAdding] = useState<Connection | null>(null);
  const pin = useSetPin();
  if (servers.length === 0) return null;
  // The dialogs sit outside the gapped column: a closed dialog still mounts an empty view,
  // which a flex gap would space out like a section.
  return (
    <View testID="household-members">
      <View className="gap-8">
        {servers.map((c) => (
          <MembersSection
            key={c.id}
            connection={c}
            showServer={servers.length > 1}
            onAdd={() => setAdding(c)}
          />
        ))}
      </View>
      <AddMemberDialog
        connection={adding}
        onClose={() => setAdding(null)}
        onSetPin={(owner) => void pin.start(owner)}
      />
      {pin.dialog}
    </View>
  );
}

/**
 * One server's household: the members the person listening manages (a card each), "Add
 * someone to your household" while they may add and are under the server's cap, else one
 * line saying why not (the server's `reason`, or the cap). For a member (the server's
 * `reason: member`), the section says who manages their account instead of "People
 * you've added" (`user.managed_by` of their connection).
 */
function MembersSection({
  connection,
  showServer,
  onAdd,
}: {
  connection: Connection;
  showServer: boolean;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const list = useHouseholdMembers(connection.id);
  const server = connection.name;
  const data = list.data;
  const block = data ? addBlock(data) : null;
  // A member's own Household: who manages them (their connection's `managed_by`).
  const owner = useManagerName(connection.id);
  const manager = data?.reason === 'member' ? owner : null;

  return (
    <View className="gap-3" testID={`household-members-${connection.id}`}>
      <SectionTitle
        title={
          showServer ? t('household.members.titleOn', { server }) : t('household.members.title')
        }
        sub={
          manager
            ? t('household.members.managedBy', { owner: manager })
            : t('household.members.sub')
        }
      />
      {list.isError && !data ? (
        <ErrorNote
          message={t('household.members.loadFailed', { server })}
          onRetry={() => void list.refetch()}
        />
      ) : !data ? (
        <Card className="gap-3" testID="household-members-loading">
          <View className="flex-row items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <View className="flex-1 gap-2">
              <Skeleton className="h-3.5 w-1/3 rounded-sm" />
              <Skeleton className="h-3 w-1/2 rounded-sm" />
            </View>
          </View>
        </Card>
      ) : (
        <>
          {data.members.map((m) => (
            <MemberCard key={m.id} connection={connection} member={m} />
          ))}
          {data.members.length === 0 && block === null ? (
            <Text variant="muted" testID="household-members-empty">
              {t('household.members.empty')}
            </Text>
          ) : null}
          {block === null ? (
            <View className="flex-row flex-wrap items-center gap-x-4 gap-y-2">
              <Button
                testID={`household-add-${connection.id}`}
                title={t('household.members.add')}
                icon="plus"
                onPress={onAdd}
              />
              <Text variant="caption">
                {t('household.members.count', { count: data.members.length, max: data.max })}
              </Text>
            </View>
          ) : (
            <Text variant="muted" testID="household-add-blocked">
              {manager
                ? t('household.members.reason.memberNamed', { owner: manager })
                : t(`household.members.reason.${block}`, { max: data.max })}
            </Text>
          )}
        </>
      )}
    </View>
  );
}
