import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { ApiKey } from '@/api/types';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { formatRelative } from '@/lib/format';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

import type { ApiKeysManager } from './use-api-keys-manager';

/**
 * Settings section to manage this connection's API keys: name and create one (the
 * secret is revealed once via the screen-level {@link ApiKeyCreatedModal}), see the
 * existing keys with when they were created and last used, and revoke one (confirmed
 * by the screen-level dialog). Gated by the caller on the server's `api_keys`
 * capability and the non-demo rule, so it renders only where keys are supported.
 *
 * State lives in {@link useApiKeysManager} (owned by the account screen so the reveal
 * modal and revoke confirmation can be hoisted out of the scroll container); this
 * component is the in-scroll view over it.
 */
export function ApiKeysSection({ manager }: { manager: ApiKeysManager }) {
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <Text variant="label">{t('settings.apiKeys.label')}</Text>
      <Card className="gap-4">
        <Text variant="muted" className="text-xs">
          {t('settings.apiKeys.hint')}
        </Text>

        <View>
          <TextField
            label={t('settings.apiKeys.nameLabel')}
            placeholder={t('settings.apiKeys.namePlaceholder')}
            autoCapitalize="none"
            value={manager.label}
            onChangeText={manager.setLabel}
            error={manager.createError ?? undefined}
            onSubmitEditing={() => void manager.create()}
          />
          <Button
            title={t('settings.apiKeys.create')}
            icon="plus"
            loading={manager.createBusy}
            disabled={!manager.canCreate}
            onPress={() => void manager.create()}
          />
        </View>

        {manager.isLoading ? (
          <Spinner />
        ) : manager.isError ? (
          <Text variant="muted">{t('settings.apiKeys.loadError')}</Text>
        ) : manager.keys.length === 0 ? (
          <Text variant="muted">{t('settings.apiKeys.empty')}</Text>
        ) : (
          <View className="gap-2">
            {manager.keys.map((k) => (
              <ApiKeyRow key={k.id} apiKey={k} onRevoke={() => manager.requestRevoke(k)} />
            ))}
          </View>
        )}

        {manager.revokeError ? (
          <Text className="text-xs text-red-500">{manager.revokeError}</Text>
        ) : null}
      </Card>
    </View>
  );
}

function ApiKeyRow({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke: () => void }) {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  return (
    <View className="flex-row items-center gap-1 rounded-xl bg-white pr-1 shadow-sm dark:border dark:border-gray-860 dark:bg-gray-840 dark:shadow-none">
      <View className="flex-1 flex-row items-center gap-3 px-3 py-3">
        <Icon name="settings" size={18} color={colors[scheme].textMuted} />
        <View className="flex-1">
          <Text variant="subtitle" numberOfLines={1}>
            {apiKey.label}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {t('settings.apiKeys.created', { when: formatRelative(apiKey.created_at) })}
            {' · '}
            {apiKey.last_seen
              ? t('settings.apiKeys.lastUsed', { when: formatRelative(apiKey.last_seen) })
              : t('settings.apiKeys.neverUsed')}
          </Text>
        </View>
      </View>
      <AnimatedPressable
        onPress={onRevoke}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('settings.apiKeys.revoke', { name: apiKey.label })}
        className="h-9 w-9 items-center justify-center rounded-full active:bg-danger/10"
      >
        <Icon name="trash" size={16} color={colors.danger} />
      </AnimatedPressable>
    </View>
  );
}
