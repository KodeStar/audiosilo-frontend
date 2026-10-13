import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

import { DevicePeople } from './device-people';
import { HouseSharing } from './house-sharing';
import { HouseholdMembers } from './members-section';

/**
 * The Household page (Phase 8b-1; it was Settings > Household and sharing in Phase 8):
 * the people on this device (names, PINs, kids mode, Who's listening?, "Sign in someone
 * who already has an account", ask at launch), the household members the person listening
 * manages on each server with `household_members` (their cards and "Add someone to your
 * household"), then Listening in the house. A plain column: the `/household` route and the
 * phone You hub's Household segment (`embedded`: the hub's large title already says
 * Household) each scroll it.
 */
export function HouseholdPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  return (
    <View className="w-full max-w-[880px] gap-10 self-center" testID="household-page">
      {embedded ? null : (
        <Text variant="display" accessibilityRole="header">
          {t('household.title')}
        </Text>
      )}
      <DevicePeople />
      <HouseholdMembers />
      <HouseSharing />
    </View>
  );
}
