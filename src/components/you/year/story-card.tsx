import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Logo } from '@/components/brand/logo';
import { Portrait } from '@/components/series/portrait';
import { Icon } from '@/components/ui/icon';
import { tabularNums } from '@/theme/tabular-nums';
import { colors } from '@/theme/tokens';

import { CARD_DESIGN_WIDTH, cardHeight } from './card-size';
import { StoryBackground } from './story-background';
import { StoryClock } from './story-clock';
import { StoryCoverArt } from './story-cover';
import { StreakGrid, Tower } from './story-pieces';
import { StoryText } from './story-text';
import type { CardCopy } from './year-copy';
import type { YearCard } from './year-model';

/** The product's name beside its mark on the summary card (a name, not translated). */
const BRAND = 'AudioSilo';

/**
 * One story card (STYLEGUIDE section 8, "Year in listening"; the prototype's
 * `YearCards()`), drawn at any width as a 9:16 picture: its theme's ground, then the
 * card's words (`cardCopy`) and drawing. The SAME component is what the story shows and
 * what a share captures, so it holds no controls: the progress bars and the tap zones are
 * the stage's, laid over it. `plainCovers` draws covers as title blocks (a share's second
 * try).
 */
export function StoryCard({
  card,
  copy,
  width,
  connectionId,
  plainCovers = false,
}: {
  card: YearCard;
  copy: CardCopy;
  width: number;
  connectionId: string;
  plainCovers?: boolean;
}) {
  const u = width / CARD_DESIGN_WIDTH;
  return (
    <View style={{ width, height: cardHeight(width) }} className="overflow-hidden">
      <StoryBackground theme={card.theme} />
      <View
        className="absolute inset-0"
        style={{ paddingTop: 48 * u, paddingHorizontal: 26 * u, paddingBottom: 26 * u }}
      >
        <Kicker u={u}>{copy.kicker}</Kicker>
        <CardBody
          card={card}
          copy={copy}
          u={u}
          width={width}
          connectionId={connectionId}
          plainCovers={plainCovers}
        />
      </View>
    </View>
  );
}

function CardBody({
  card,
  copy,
  u,
  width,
  connectionId,
  plainCovers,
}: {
  card: YearCard;
  copy: CardCopy;
  u: number;
  width: number;
  connectionId: string;
  plainCovers: boolean;
}) {
  switch (card.kind) {
    case 'hours':
      return (
        <View style={{ marginTop: 'auto', gap: 6 * u }}>
          {copy.title ? <Heading u={u}>{copy.title}</Heading> : null}
          <View style={{ marginTop: 10 * u }}>
            <Big u={u}>{copy.big}</Big>
            <Heading u={u} size={22}>
              {copy.unit}
            </Heading>
          </View>
          <Lines u={u} lines={copy.body} />
        </View>
      );
    case 'books':
      return (
        <>
          <View style={{ marginTop: 8 * u, gap: 4 * u }}>
            <Big u={u}>{copy.big}</Big>
            <Heading u={u} size={22}>
              {copy.unit}
            </Heading>
            <Lines u={u} lines={copy.body} />
          </View>
          <View style={{ marginTop: 'auto', marginBottom: 6 * u }}>
            <Tower spines={card.spines} unit={u} />
          </View>
        </>
      );
    case 'book':
      return (
        <View className="flex-1 justify-center" style={{ gap: 6 * u, paddingBottom: 24 * u }}>
          <View className="items-center" style={{ marginBottom: 12 * u }}>
            <StoryCoverArt
              connectionId={connectionId}
              book={card.book}
              width={Math.round(width * 0.62)}
              plain={plainCovers}
            />
          </View>
          {copy.title ? (
            <Heading u={u} lines={3}>
              {copy.title}
            </Heading>
          ) : null}
          <Lines u={u} lines={copy.body} />
        </View>
      );
    case 'voice':
      return (
        <View className="flex-1 justify-center" style={{ gap: 6 * u, paddingBottom: 24 * u }}>
          <View style={{ marginBottom: 12 * u }}>
            <Portrait name={card.narrator.name} kind="narrator" size={140 * u} />
          </View>
          {copy.title ? <Heading u={u}>{copy.title}</Heading> : null}
          <Lines u={u} lines={copy.body} />
        </View>
      );
    case 'clock':
      return (
        <View className="flex-1">
          {copy.title ? (
            <View style={{ marginTop: 8 * u }}>
              <Heading u={u}>{copy.title}</Heading>
            </View>
          ) : null}
          <View className="flex-1 items-center justify-center">
            <StoryClock
              size={250 * u}
              hours={card.hours}
              value={copy.clock?.value ?? ''}
              caption={copy.clock?.caption ?? ''}
            />
          </View>
          <Lines u={u} lines={copy.body} />
        </View>
      );
    case 'streak':
      return (
        <>
          <View style={{ marginTop: 8 * u, gap: 4 * u }}>
            <Big u={u}>{copy.big}</Big>
            <Heading u={u} size={22}>
              {copy.unit}
            </Heading>
          </View>
          <View style={{ marginTop: 'auto', gap: 12 * u }}>
            <StreakGrid weeks={card.grid} unit={u} />
            <Lines u={u} lines={copy.body} />
          </View>
        </>
      );
    case 'people':
      return (
        <View style={{ marginTop: 'auto', gap: 22 * u }}>
          {(copy.rows ?? []).map((row, i) => (
            <View key={row.label} className="flex-row items-center" style={{ gap: 14 * u }}>
              {i === 0 && card.author ? (
                <Portrait name={card.author.name} kind="author" size={64 * u} />
              ) : (
                <View
                  className="items-center justify-center"
                  style={{
                    width: 64 * u,
                    height: 64 * u,
                    borderRadius: 18 * u,
                    backgroundColor: 'rgba(255, 255, 255, 0.14)',
                  }}
                >
                  <Icon name="layers" size={28 * u} color={colors.white} />
                </View>
              )}
              <View className="min-w-0 flex-1" style={{ gap: 2 * u }}>
                <Kicker u={u}>{row.label}</Kicker>
                <Heading u={u} size={22} lines={2}>
                  {row.name}
                </Heading>
                <Lines u={u} lines={[row.detail]} />
              </View>
            </View>
          ))}
        </View>
      );
    case 'summary':
      return (
        <>
          <View className="flex-1 justify-center" style={{ gap: 26 * u }}>
            <View className="flex-row flex-wrap" style={{ rowGap: 14 * u }}>
              {(copy.figures ?? []).map((f) => (
                <View key={f.label} style={{ width: '50%', paddingRight: 8 * u }}>
                  <StoryText
                    className="font-display"
                    style={[
                      tabularNums,
                      { fontSize: 44 * u, lineHeight: 46 * u, letterSpacing: -1.8 * u },
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {f.value}
                  </StoryText>
                  <StoryText style={{ fontSize: 13 * u, lineHeight: 18 * u, opacity: 0.85 }}>
                    {f.label}
                  </StoryText>
                </View>
              ))}
            </View>
            <View className="flex-row" style={{ gap: 4 * u }}>
              {card.covers.map((b) => (
                <StoryCoverArt
                  key={`${b.library_id}:${b.path}`}
                  connectionId={connectionId}
                  book={b}
                  width={Math.floor(44 * u)}
                  plain={plainCovers}
                />
              ))}
            </View>
          </View>
          <View className="flex-row items-center" style={{ gap: 6 * u }}>
            <Logo size={16 * u} color={colors.white} />
            <StoryText
              className="font-sans-bold"
              style={{ fontSize: 11.5 * u, lineHeight: 16 * u, opacity: 0.9 }}
            >
              {BRAND}
            </StoryText>
          </View>
        </>
      );
  }
}

/** The small caps line at the top of a card (`.st-k`). */
function Kicker({ u, children }: { u: number; children: ReactNode }) {
  return (
    <StoryText
      className="font-sans-bold uppercase"
      style={{ fontSize: 12 * u, lineHeight: 16 * u, letterSpacing: 1.7 * u, opacity: 0.85 }}
      numberOfLines={2}
    >
      {children}
    </StoryText>
  );
}

/** A card's heading (`.st-h`): Bricolage, 30 units (22 under a big figure). */
function Heading({
  u,
  size = 30,
  lines = 4,
  children,
}: {
  u: number;
  size?: number;
  lines?: number;
  children: ReactNode;
}) {
  return (
    <StoryText
      className="font-display"
      style={{ fontSize: size * u, lineHeight: size * 1.06 * u, letterSpacing: -0.03 * size * u }}
      numberOfLines={lines}
    >
      {children}
    </StoryText>
  );
}

/** A card's big figure (`.st-big`): Bricolage, 92 units, tabular. */
function Big({ u, children }: { u: number; children: ReactNode }) {
  return (
    <StoryText
      className="font-display"
      style={[tabularNums, { fontSize: 92 * u, lineHeight: 86 * u, letterSpacing: -4.5 * u }]}
      numberOfLines={1}
      adjustsFontSizeToFit
    >
      {children}
    </StoryText>
  );
}

/** A card's running lines (`.st-p`). */
function Lines({ u, lines }: { u: number; lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <View style={{ gap: 6 * u }}>
      {lines.map((line) => (
        <StoryText
          key={line}
          style={{ fontSize: 14.5 * u, lineHeight: 21 * u, opacity: 0.88 }}
          numberOfLines={4}
        >
          {line}
        </StoryText>
      ))}
    </View>
  );
}
