import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Portrait } from '@/components/series/portrait';
import { SettingRow } from '@/components/settings/settings-row';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/** A person card's head on the Household page (a person on this device, a household
 * member): their portrait (ringed while `ring`), name as the card's heading, one line of
 * `detail`, and what sits at the end (a badge, Switch). */
export function PersonHeader({
  name,
  detail,
  ring = false,
  children,
}: {
  name: string;
  detail: string;
  ring?: boolean;
  children?: ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-3 py-3.5">
      <Portrait name={name} kind="user" size={36} ring={ring} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="label" numberOfLines={1} accessibilityRole="header">
          {name}
        </Text>
        <Text variant="caption" numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {children}
    </View>
  );
}

/** A person card's Rename row: their name, and Rename (`onRename` opens the dialog). */
export function RenameRow({ name, onRename }: { name: string; onRename: () => void }) {
  const { t } = useTranslation();
  return (
    <SettingRow label={t('profiles.rename.label')} description={name}>
      <Button
        title={t('profiles.rename.action')}
        accessibilityLabel={t('profiles.rename.title', { name })}
        variant="ghost"
        size="sm"
        icon="pen"
        onPress={onRename}
      />
    </SettingRow>
  );
}
