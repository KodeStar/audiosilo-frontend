import { useState } from 'react';
import { Platform, Pressable, View, type ViewStyle } from 'react-native';
import Svg, { Defs, Line, LinearGradient, Rect, Stop } from 'react-native-svg';

import type { CoverColor } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { useDomId } from '@/lib/use-dom-id';
import { cn } from '@/lib/utils';
import { colors } from '@/theme/tokens';
import { useThemeColors } from '@/theme/use-theme-colors';

import { spinePalette } from './spine-colors';
import {
  fitSpineTitle,
  SPINE_AUTHOR_MIN_WIDTH,
  type SpineFoot,
  spineGeometry,
  spineIndexSize,
} from './spine-fit';

/** How far the book you're on stands out of the row (STYLEGUIDE: "lifted 14 px"). */
export const READING_LIFT = 14;

export type SpineVariant = 'book' | 'ghost' | 'elsewhere';

export type SpineProps = {
  /** The title along the spine ("Book 3" for a gap with no title). */
  title: string;
  /** The series number at the top. */
  position?: string;
  width: number;
  height: number;
  /** The shelf's scale (1 = the style guide's sizes). */
  scale: number;
  /** `book`: one of the listener's own books, in its cover's colours. `ghost`: a book on
   * no server (dashed, hatched). `elsewhere`: a ghost on another connected server, in
   * `info` with a server mark. */
  variant: SpineVariant;
  coverColor?: CoverColor;
  author?: string;
  finished?: boolean;
  /** The book you're on: lifted out of the row (the ribbon is the shelf's to draw). */
  reading?: boolean;
  /** Without one the spine is decoration (the mini shelves): no button, no focus. */
  onPress?: () => void;
  accessibilityLabel?: string;
};

const STRIPE = 8;

/**
 * A book spine (STYLEGUIDE section 8, "Spine"): a vertical book in its cover's colours
 * with a rounded top, side shading and two bands framing the title, which runs up the
 * spine and always fits (`fitSpineTitle`: tighten, shrink, wrap, ellipsize last); the
 * series number at the top; the author's surname at the foot when it is wide enough, or
 * a green check when finished. A ghost is dashed and hatched, in `info` with a server
 * mark when another connected server has the book. Shadows on spines only.
 */
export function Spine({
  title,
  position,
  width,
  height,
  scale,
  variant,
  coverColor,
  author,
  finished,
  reading,
  onPress,
  accessibilityLabel,
}: SpineProps) {
  const themed = useThemeColors();
  const id = useDomId('sp');
  const [hovered, setHovered] = useState(false);
  const ghost = variant !== 'book';
  const surname = author?.trim().split(/\s+/).pop() ?? '';
  const foot: SpineFoot = finished
    ? 'finished'
    : variant === 'elsewhere'
      ? 'server'
      : !ghost && surname && width >= SPINE_AUTHOR_MIN_WIDTH * scale
        ? 'author'
        : 'none';
  const g = spineGeometry(width, height, scale, foot);
  const fit = fitSpineTitle({
    text: title,
    base: (ghost ? 12 : 12.5) * scale,
    length: g.length,
    across: g.across,
    width,
    font: ghost ? 'sans' : 'display',
  });
  const palette = ghost ? null : spinePalette(coverColor, title);
  const ink = palette
    ? palette.ink
    : variant === 'elsewhere'
      ? themed.info
      : themed.mutedForeground;
  const lift = (reading ? READING_LIFT : 0) + (hovered && onPress ? (ghost ? 4 : 10) : 0);

  const body = (
    <View
      style={{
        width,
        height,
        borderTopLeftRadius: 3,
        borderTopRightRadius: 3,
        borderBottomLeftRadius: 2,
        borderBottomRightRadius: 2,
        backgroundColor: palette?.body,
        ...(ghost ? null : { boxShadow: SPINE_SHADOW[reading ? 'lifted' : 'resting'] }),
      }}
      className={cn(
        ghost && 'border-[1.5px] border-dashed',
        variant === 'ghost' && 'border-subtle-foreground',
        variant === 'elsewhere' && 'border-info/70',
      )}
    >
      <View className="absolute inset-0 overflow-hidden" style={{ borderRadius: 2 }}>
        <Svg width="100%" height="100%">
          {palette ? (
            <>
              <Defs>
                <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0">
                  <Stop offset={0} stopColor={colors.black} stopOpacity={0.22} />
                  <Stop offset={0.14} stopColor={colors.white} stopOpacity={0.1} />
                  <Stop offset={0.34} stopColor={colors.black} stopOpacity={0} />
                  <Stop offset={0.76} stopColor={colors.black} stopOpacity={0} />
                  <Stop offset={1} stopColor={colors.black} stopOpacity={0.26} />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill={`url(#${id})`} />
            </>
          ) : (
            Array.from({ length: Math.floor(height / STRIPE) }, (_, i) => (
              <Line
                key={i}
                x1={0}
                x2={width}
                y1={(i + 1) * STRIPE - 0.5}
                y2={(i + 1) * STRIPE - 0.5}
                stroke={variant === 'elsewhere' ? themed.info : themed.borderStrong}
                strokeOpacity={variant === 'elsewhere' ? 0.18 : 0.5}
                strokeWidth={1}
              />
            ))
          )}
        </Svg>
      </View>
      <View style={{ paddingTop: g.padTop, height: g.padTop + g.indexHeight }}>
        <Text
          numberOfLines={1}
          className="text-center font-mono"
          style={{
            color: ink,
            opacity: 0.85,
            fontSize: spineIndexSize(position ?? '', g.across, scale),
            lineHeight: g.indexHeight,
          }}
        >
          {position ?? ''}
        </Text>
      </View>
      <View
        style={{
          height: g.bandHeight,
          marginVertical: g.bandMargin,
          borderTopWidth: palette ? 2 : 0,
          borderBottomWidth: palette ? 2 : 0,
          borderColor: palette?.band,
        }}
        className="items-center justify-center overflow-hidden"
      >
        <View
          style={{
            width: g.length,
            height: g.across,
            transform: [{ rotate: '-90deg' }],
          }}
          className="items-center justify-center"
        >
          {fit.lines.map((line, i) => (
            <Text
              key={i}
              numberOfLines={1}
              ellipsizeMode="tail"
              className={cn('w-full text-center', ghost ? 'font-sans-semibold' : 'font-display')}
              style={{
                color: ink,
                fontSize: fit.fontSize,
                lineHeight: fit.fontSize * 1.1,
                letterSpacing: fit.letterSpacing * fit.fontSize,
              }}
            >
              {line}
            </Text>
          ))}
        </View>
      </View>
      <View style={{ height: g.footHeight }} className="items-center justify-center">
        {foot === 'author' ? (
          <Text
            numberOfLines={1}
            className="px-0.5 text-center font-sans-bold uppercase"
            style={{
              color: ink,
              opacity: 0.8,
              fontSize: 8.5 * scale,
              letterSpacing: 0.85 * scale,
            }}
          >
            {surname}
          </Text>
        ) : foot === 'finished' ? (
          <View
            className="items-center justify-center rounded-full bg-success"
            style={{ width: 16 * scale, height: 16 * scale }}
          >
            <Icon name="check" size={Math.round(10 * scale)} color={colors.white} />
          </View>
        ) : foot === 'server' ? (
          <Icon name="server" size={Math.round(11 * scale)} color={themed.info} />
        ) : null}
      </View>
    </View>
  );

  const style = { transform: [{ translateY: -lift }] };
  if (!onPress) {
    return (
      <View
        style={style}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {body}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      style={style}
      hitSlop={{ top: 8, bottom: 8 }}
      className={Platform.select({
        web: `cursor-pointer rounded-sm transition-transform ${FOCUS_RING_OFFSET_CLASS}`,
      })}
    >
      {body}
    </Pressable>
  );
}

/** The spine shadow (STYLEGUIDE: shadows on covers and spines only), deeper when the
 * book is lifted out of the row. */
const SPINE_SHADOW = {
  resting: '0px 1px 2px rgba(0, 0, 0, 0.25), 0px 8px 14px -8px rgba(0, 0, 0, 0.4)',
  lifted: '0px 1px 2px rgba(0, 0, 0, 0.25), 0px 18px 24px -10px rgba(0, 0, 0, 0.45)',
} as const;

export const RIBBON_WIDTH = 10;

/** The bookmark ribbon of the book you're on, drawn by the shelf BEHIND the book so only
 * the part above its top edge shows (never over cover or spine type). */
export function Ribbon({ height, style }: { height: number; style: ViewStyle }) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute rounded-t-[1px] bg-brand"
      style={[{ width: RIBBON_WIDTH, height, boxShadow: '0px 2px 2px rgba(0, 0, 0, 0.25)' }, style]}
    />
  );
}
