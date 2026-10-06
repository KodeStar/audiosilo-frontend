import type { ViewStyle } from 'react-native';

/**
 * The outer style every horizontal ScrollView (or horizontal list) needs. React Native's
 * ScrollView defaults to `flexGrow: 1`, and on native Yoga's legacy stretch lets that grow
 * an auto-height parent to fill the free space of the column above it: the phone
 * Library's section switcher swallowed the screen and left its grid 0 tall. The web's CSS
 * doesn't stretch that way, so only a device shows it; a sideways row must opt out.
 */
export const HORIZONTAL_SCROLLER: ViewStyle = { flexGrow: 0 };
