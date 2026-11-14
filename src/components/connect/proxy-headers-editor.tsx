import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

import { ConnectInput } from './connect-frame';
import { blankRow, canAddRow, draftProblems, type HeaderDraftRow } from './proxy-headers-model';

/**
 * The rows of custom headers for an auth proxy (fe#167): a name and a value each, the value
 * typed into a password field (never shown back), a row loaded from the connection showing
 * "Kept as it is" until a new value is typed. Each row says what is wrong with it under
 * itself. Used on the connect screen and the Account page's Proxy headers card (where
 * `ConnectInput`'s scroll into view is a no-op: no `ConnectFrame` above it).
 */
export function ProxyHeadersEditor({
  rows,
  onChange,
  showProblems = true,
}: {
  rows: readonly HeaderDraftRow[];
  onChange: (rows: HeaderDraftRow[]) => void;
  /** Say each row's problem (off until the listener has tried to use the rows). */
  showProblems?: boolean;
}) {
  const { t } = useTranslation();
  const problems = draftProblems(rows);
  const update = (key: string, patch: Partial<HeaderDraftRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: string) => {
    const left = rows.filter((r) => r.key !== key);
    onChange(left.length ? left : [blankRow()]);
  };
  return (
    <View className="gap-3" testID="proxy-headers-editor">
      {rows.map((row, i) => {
        const problem = showProblems ? problems[i] : null;
        const name = row.name.trim();
        return (
          <View key={row.key} className="gap-1" testID="proxy-headers-editor-row">
            <View className="flex-row flex-wrap items-center gap-2">
              <View className="min-w-[140px] flex-1">
                <ConnectInput
                  accessibilityLabel={t('proxyHeaders.name')}
                  placeholder={t('proxyHeaders.namePlaceholder')}
                  value={row.name}
                  onChangeText={(name) => update(row.key, { name })}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  testID="proxy-headers-editor-name"
                />
              </View>
              <View className="min-w-[140px] flex-1">
                <ConnectInput
                  accessibilityLabel={
                    name ? t('proxyHeaders.valueOf', { name }) : t('proxyHeaders.value')
                  }
                  placeholder={
                    row.stored !== undefined ? t('proxyHeaders.valueKept') : t('proxyHeaders.value')
                  }
                  value={row.value}
                  onChangeText={(value) => update(row.key, { value })}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  textContentType="none"
                  autoComplete="off"
                  testID="proxy-headers-editor-value"
                />
              </View>
              <Button
                variant="ghost"
                size="icon"
                icon="close"
                accessibilityLabel={
                  name ? t('proxyHeaders.removeNamed', { name }) : t('proxyHeaders.remove')
                }
                onPress={() => remove(row.key)}
                testID="proxy-headers-editor-remove"
              />
            </View>
            {problem ? (
              <Text variant="caption" className="text-destructive" role="alert">
                {t(`proxyHeaders.problem.${problem}`, { name })}
              </Text>
            ) : null}
          </View>
        );
      })}
      {canAddRow(rows) ? (
        <Button
          className="self-start"
          variant="outline"
          size="sm"
          icon="plus"
          title={t('proxyHeaders.add')}
          onPress={() => onChange([...rows, blankRow()])}
          testID="proxy-headers-editor-add"
        />
      ) : null}
    </View>
  );
}
