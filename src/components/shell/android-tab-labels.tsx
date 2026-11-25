import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, useWindowDimensions } from 'react-native';

import { useFontScale } from '@/lib/text-scale';

import { TABS } from './destinations';
import { TAB_LABEL_BASE_SP, tabLabelFontSize } from './tab-label-size';

/** The native bar applies one size to all labels. A single text node takes the
 * intrinsic width of the widest translated line, in the Android system typeface.
 * The probe stays outside the navigator and the accessibility tree. */
export function useAndroidTabLabels() {
  const { t } = useTranslation();
  const scale = useFontScale();
  const slot = useWindowDimensions().width / TABS.length;
  const [width, setWidth] = useState(0);
  const labelStyle = useMemo(
    () => ({ fontSize: tabLabelFontSize(scale, slot, width) }),
    [scale, slot, width],
  );
  return {
    labelStyle,
    probe: (
      <Text
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        allowFontScaling={false}
        // Material labels have tracking in addition to the system font's advances.
        style={{
          position: 'absolute',
          alignSelf: 'flex-start',
          opacity: 0,
          fontSize: TAB_LABEL_BASE_SP,
          letterSpacing: 0.5,
        }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        {TABS.map((d) => t(d.labelKey)).join('\n')}
      </Text>
    ),
  };
}
