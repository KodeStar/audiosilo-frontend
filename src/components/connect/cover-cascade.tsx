import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { Text } from '@/components/ui/text';
import { useDomId } from '@/lib/use-dom-id';
import { colors } from '@/theme/tokens';

import { cascadeColumns, type PatternTile, solidTiles } from './cover-patterns';

/**
 * The connect screens' right-hand panel (tablet and desktop): a tilted cascade of covers
 * behind "Every book in the house, on every device." Before sign-in there are no real
 * covers, so the cascade is generated: abstract cloth-coloured squares with a simple
 * motif each (a sun, arcs, bands, dots) and a few dashed ghosts, never a title that could
 * pass for one of the listener's books. Static (only live indicators loop), decorative.
 */

/** The panel's own ground: a deep ink that stays dark in both themes (like a cover wash,
 * a content colour, not a theme token), so the white type on it always reads. */
export const PANEL_INK = '#0d1428';

/** The columns of the cascade and the tiles in each. */
const COLUMNS = 6;
const PER_COLUMN = 7;
const GAP = 16;

export function CoverCascadePanel({ flex = 1 }: { flex?: number }) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const scrim = useDomId('scrim');
  // Tiles scale with the panel: about four across its width before the tilt.
  const tile = Math.max(92, Math.round(width / 4.2));
  const columns = cascadeColumns(COLUMNS, PER_COLUMN);
  return (
    <View
      testID="cover-cascade"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ flex, backgroundColor: PANEL_INK }}
      className="justify-end overflow-hidden p-10"
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: -tile,
          left: -tile * 1.2,
          right: -tile * 1.2,
          bottom: -tile,
          flexDirection: 'row',
          gap: GAP,
          opacity: 0.92,
          transform: [{ rotate: '-12deg' }],
        }}
      >
        {width > 0
          ? columns.map((col, c) => (
              <View
                key={c}
                style={{ gap: GAP, marginTop: c % 2 ? -tile * 0.45 : 0 }}
                className="flex-col"
              >
                {col.map((p, i) => (
                  <PatternCover key={i} tile={p} size={tile} />
                ))}
              </View>
            ))
          : null}
      </View>
      {/* The scrim the words sit on: clear at the top, the panel's ink at the foot. */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
      >
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id={scrim} x1="0" y1="0" x2="0" y2="1">
              <Stop offset={0.3} stopColor={PANEL_INK} stopOpacity={0.05} />
              <Stop offset={0.88} stopColor={PANEL_INK} stopOpacity={0.94} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#${scrim})`} />
        </Svg>
      </View>
      <View className="max-w-[420px] gap-2">
        <Text variant="heading" className="text-[26px] leading-[30px] text-white">
          {t('onboarding.panel.title')}
        </Text>
        <Text className="text-white/75">{t('onboarding.panel.body')}</Text>
      </View>
    </View>
  );
}

/** A fan of five generated covers over the phone's first step (the prototype's fan of
 * covers, without fake titles). Decorative. */
export function CoverFan() {
  const tiles = solidTiles(5);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="h-[112px] flex-row items-end justify-center"
    >
      {tiles.map((p, i) => {
        const off = i - 2;
        return (
          <View
            key={i}
            style={{
              marginLeft: i ? -20 : 0,
              zIndex: 5 - Math.abs(off),
              transform: [{ rotate: `${off * 7}deg` }, { translateY: Math.abs(off) * 6 }],
            }}
          >
            <PatternCover tile={p} size={off === 0 ? 96 : 78} />
          </View>
        );
      })}
    </View>
  );
}

/** One generated cover: a cloth square with its motif (or a dashed ghost). */
function PatternCover({ tile, size }: { tile: PatternTile; size: number }) {
  if (tile.motif === 'ghost') {
    return (
      <View
        style={{ width: size, height: size, borderColor: 'rgba(255,255,255,0.28)' }}
        className="rounded-cover border-[1.5px] border-dashed bg-white/5"
      />
    );
  }
  const s = size;
  const { cloth, accent } = tile;
  return (
    <View
      style={{ width: s, height: s, backgroundColor: cloth, boxShadow: COVER_SHADOW }}
      className="overflow-hidden rounded-cover"
    >
      <Svg width={s} height={s} viewBox="0 0 100 100">
        {tile.motif === 'sun' ? (
          <>
            <Circle cx={50} cy={58} r={22} fill={accent} />
            <Rect x={0} y={62} width={100} height={38} fill={cloth} opacity={0.92} />
            <Line x1={8} y1={62} x2={92} y2={62} stroke={accent} strokeWidth={1.5} />
          </>
        ) : tile.motif === 'arcs' ? (
          [14, 26, 38, 50].map((r) => (
            <Circle
              key={r}
              cx={50}
              cy={100}
              r={r}
              fill="none"
              stroke={accent}
              strokeWidth={3}
              opacity={0.35 + r / 100}
            />
          ))
        ) : tile.motif === 'bands' ? (
          <>
            <Rect x={0} y={22} width={100} height={12} fill={accent} />
            <Rect x={0} y={40} width={100} height={4} fill={accent} opacity={0.6} />
            <Rect x={14} y={64} width={44} height={6} rx={3} fill={colors.white} opacity={0.5} />
          </>
        ) : tile.motif === 'dots' ? (
          [20, 40, 60, 80].flatMap((x) =>
            [20, 40, 60, 80].map((y) => (
              <Circle
                key={`${x}-${y}`}
                cx={x}
                cy={y}
                r={(x + y) % 40 === 0 ? 6 : 3}
                fill={accent}
              />
            )),
          )
        ) : (
          <Path d="M0 100 L50 30 L100 100 Z" fill={accent} opacity={0.85} />
        )}
        {/* The spine crease every cover carries. */}
        <Rect x={0} y={0} width={4} height={100} fill={colors.black} opacity={0.18} />
      </Svg>
    </View>
  );
}

const COVER_SHADOW = '0 6px 18px rgba(0,0,0,0.35)';
