import {
  HStack,
  Image,
  ProgressView,
  RoundedRectangle,
  Spacer,
  Text,
  VStack,
  ZStack,
} from '@expo/ui/swift-ui';
import {
  aspectRatio,
  clipShape,
  containerBackground,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  monospacedDigit,
  padding,
  progressViewStyle,
  resizable,
  tint,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';

import type { ContinueListeningProps } from './widget-model';

/**
 * The "Continue listening" home screen widget: the book that is loaded (or
 * was last), display only, opening its player on a tap.
 *
 * The function below is NOT React. The `'widget'` directive makes babel-preset-expo turn
 * it into a source string that the widget extension evaluates in its own JavaScriptCore
 * context, where `@expo/ui/swift-ui` components and modifiers are globals. So:
 * - no hooks, no imports used at runtime other than those two modules (by their ORIGINAL
 *   names: an aliased import would not exist there), and nothing from module scope - the
 *   palette lives inside the function;
 * - every string arrives in `props`, already localized by the app (`widget-model.ts`);
 * - the cover is a file in `widgetsDirectory`: the extension cannot fetch.
 *
 * Styled to Stacks with the system font: Bricolage Grotesque and Figtree are bundled with
 * the app, not the extension. `systemSmall` is the cover and the title; `systemMedium` adds
 * the author, the chapter, the time left and a quiet progress bar, the one pink thing.
 */
const ContinueListening = (props: ContinueListeningProps, environment: WidgetEnvironment) => {
  'widget';
  const dark = environment.colorScheme === 'dark';
  const card = dark ? '#10172b' : '#ffffff';
  const fg = dark ? '#e7ebf4' : '#121c36';
  const muted = dark ? '#8f9ab3' : '#5b6680';
  const well = dark ? '#151d34' : '#eef1f5';
  const brand = dark ? '#ec4f95' : '#db2777';
  const small = environment.widgetFamily === 'systemSmall';
  // Plain expressions in here (concat, not a spread): the source runs as written in the
  // extension, where no babel helper exists if a transform ever wanted one.
  const root = [containerBackground(card, 'widget')].concat(
    props.deepLink ? [widgetURL(props.deepLink)] : [],
  );

  // The cover with its placeholder underneath: a missing file draws nothing, so the
  // well and the headphones show through.
  const cover = (size: number) => (
    <ZStack modifiers={[frame({ width: size, height: size })]}>
      <RoundedRectangle
        cornerRadius={10}
        modifiers={[foregroundStyle(well), frame({ width: size, height: size })]}
      />
      <Image systemName="headphones" size={size / 3} color={muted} />
      {props.coverFile ? (
        <Image
          uiImage={props.coverFile}
          modifiers={[
            resizable(),
            aspectRatio({ ratio: 1, contentMode: 'fill' }),
            frame({ width: size, height: size }),
            clipShape('roundedRectangle', 10),
          ]}
        />
      ) : null}
    </ZStack>
  );

  if (!props.title) {
    return (
      <VStack
        alignment="leading"
        spacing={6}
        modifiers={[
          containerBackground(card, 'widget'),
          frame({ maxWidth: 10000, maxHeight: 10000, alignment: 'topLeading' }),
        ]}
      >
        <Image systemName="headphones" size={22} color={muted} />
        <Spacer />
        <Text modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle(fg)]}>
          {'AudioSilo'}
        </Text>
        {props.emptyText ? (
          <Text modifiers={[font({ size: 12 }), foregroundStyle(muted), lineLimit(3)]}>
            {props.emptyText}
          </Text>
        ) : null}
      </VStack>
    );
  }

  if (small) {
    return (
      <VStack alignment="leading" spacing={6} modifiers={root}>
        {cover(70)}
        <Spacer />
        <Text
          modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(fg), lineLimit(2)]}
        >
          {props.title}
        </Text>
      </VStack>
    );
  }

  return (
    <HStack spacing={12} modifiers={root}>
      {cover(112)}
      <VStack
        alignment="leading"
        spacing={2}
        modifiers={[frame({ maxWidth: 10000, alignment: 'leading' })]}
      >
        <Text
          modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle(fg), lineLimit(2)]}
        >
          {props.title}
        </Text>
        {props.author ? (
          <Text modifiers={[font({ size: 12 }), foregroundStyle(muted), lineLimit(1)]}>
            {props.author}
          </Text>
        ) : null}
        <Spacer />
        {props.chapterTitle ? (
          <Text
            modifiers={[font({ size: 13, weight: 'medium' }), foregroundStyle(fg), lineLimit(1)]}
          >
            {props.chapterTitle}
          </Text>
        ) : null}
        {props.timeLeft ? (
          <HStack spacing={4}>
            {props.isPlaying ? <Image systemName="waveform" size={10} color={muted} /> : null}
            <Text
              modifiers={[
                font({ size: 12 }),
                monospacedDigit(),
                foregroundStyle(muted),
                lineLimit(1),
              ]}
            >
              {props.timeLeft}
            </Text>
          </HStack>
        ) : null}
        {props.progress !== undefined ? (
          <ProgressView
            value={props.progress}
            modifiers={[progressViewStyle('linear'), tint(brand), padding({ top: 6 })]}
          />
        ) : null}
      </VStack>
    </HStack>
  );
};

export const ContinueListeningWidget = createWidget<ContinueListeningProps>(
  'ContinueListening',
  ContinueListening,
);
