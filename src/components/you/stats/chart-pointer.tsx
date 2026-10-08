import { type ReactNode, useState } from 'react';
import { type GestureResponderEvent, Platform, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';

/** A point in a chart's own coordinates. */
export type ChartPoint = { x: number; y: number };

type WebPointerEvent = {
  nativeEvent: { clientX: number; clientY: number; pointerType?: string };
  currentTarget: unknown;
};

/** The pointer's place relative to the element it is over (web). */
function webPoint(e: WebPointerEvent): ChartPoint | null {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect?.();
  if (!rect) return null;
  return { x: e.nativeEvent.clientX - rect.left, y: e.nativeEvent.clientY - rect.top };
}

/**
 * The layer that lets a chart be read without a list: laid over the chart's drawing (which
 * takes no touches itself, so the point is in THIS layer's coordinates), it reports the
 * point under a hovering mouse or a pen on the web, and under a tap everywhere (a phone
 * browser's touch, or iOS and Android). `onPoint(null)` when the mouse leaves. Not an
 * accessibility element: the chart around it carries the text summary.
 */
export function ChartPointer({
  onPoint,
  width,
  height,
  left = 0,
  top = 0,
  testID,
}: {
  onPoint: (point: ChartPoint | null) => void;
  width: number;
  height: number;
  left?: number;
  top?: number;
  testID?: string;
}) {
  const frame = { position: 'absolute' as const, left, top, width, height };
  if (Platform.OS === 'web') {
    const handlers = {
      onPointerMove: (e: WebPointerEvent) => onPoint(webPoint(e)),
      onPointerDown: (e: WebPointerEvent) => onPoint(webPoint(e)),
      // A finger lifting also "leaves": keep the tapped value on screen.
      onPointerLeave: (e: WebPointerEvent) => {
        if (e.nativeEvent.pointerType !== 'touch') onPoint(null);
      },
    };
    return (
      <View
        testID={testID}
        style={frame}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        {...handlers}
      />
    );
  }
  return (
    <Pressable
      testID={testID}
      style={frame}
      accessible={false}
      importantForAccessibility="no"
      onPress={(e: GestureResponderEvent) =>
        onPoint({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY })
      }
    />
  );
}

/**
 * The chart tooltip (the prototype's `.tip`): an ink label above a point, kept inside the
 * chart's width. Its own size is measured, so it never needs a percentage transform.
 */
export function ChartTip({
  x,
  y,
  boundsWidth,
  children,
  testID,
}: {
  /** The point it points at (its horizontal centre and the top it sits above). */
  x: number;
  y: number;
  boundsWidth: number;
  children: ReactNode;
  testID?: string;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const w = size?.w ?? 0;
  const h = size?.h ?? 0;
  const left = Math.max(0, Math.min(boundsWidth - w, x - w / 2));
  const above = y - h - 8;
  return (
    <View
      testID={testID}
      pointerEvents="none"
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      className="absolute rounded-[9px] bg-primary px-2.5 py-1.5 shadow-overlay"
      style={{ left, top: above < 0 ? y + 14 : above, opacity: size ? 1 : 0 }}
    >
      {children}
    </View>
  );
}

/** A tooltip's line: the value in bold, then what it is ("1h 36m · Sat 3 Oct"). */
export function TipText({ value, label }: { value: string; label: string }) {
  return (
    <Text numberOfLines={1} className="font-sans text-xs text-primary-foreground">
      <Text className="font-sans-bold text-xs text-primary-foreground">{value}</Text>
      {` · ${label}`}
    </Text>
  );
}
