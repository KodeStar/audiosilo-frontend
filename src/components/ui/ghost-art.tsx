import { View } from 'react-native';

/**
 * The pictures of an empty state (STYLEGUIDE section 8, "Empty, skeleton, first run"):
 * dashed ghost covers or ghost spines, never fake art. Decorative.
 */

/** Three dashed ghost covers fanned out (`size` each): nothing here. */
export function GhostCovers({ size = 54 }: { size?: number }) {
  return (
    <View
      style={{ height: Math.round(size * 1.33) }}
      className="flex-row items-center"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {[-1, 0, 1].map((i) => (
        <View
          key={i}
          style={{
            width: size,
            height: size,
            transform: [{ rotate: `${i * 8}deg` }],
            marginLeft: i === -1 ? 0 : -Math.round(size * 0.22),
          }}
          className="rounded-cover border-[1.5px] border-dashed border-subtle-foreground bg-muted"
        />
      ))}
    </View>
  );
}

/** Four dashed ghost spines leaning on each other: an empty shelf. */
export function GhostSpines() {
  return (
    <View
      className="h-[130px] flex-row items-end"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {[0, 1, 2, 3].map((i) => (
        <View
          key={i}
          style={{
            height: 90 + i * 12,
            width: 26 + i * 3,
            transform: i === 3 ? [{ rotate: '12deg' }, { translateX: 8 }] : undefined,
          }}
          className="mr-0.5 rounded-t-[4px] border-[1.5px] border-dashed border-subtle-foreground bg-muted"
        />
      ))}
    </View>
  );
}
