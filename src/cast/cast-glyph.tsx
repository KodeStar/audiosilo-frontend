import Svg, { Path } from 'react-native-svg';

/**
 * The Cast glyph, for the buttons the app draws itself (the web's, and the native one that
 * explains why a book can't be cast; the native button that casts is the SDK's own). The
 * vendored FontAwesome set has no Cast glyph and adding one needs the generator's token, so
 * this is the Material Design "cast" / "cast_connected" icon (Apache License 2.0), which is
 * also the glyph Google's guidelines ask senders to use.
 */
const CAST =
  'M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z';
const CAST_CONNECTED =
  'M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm18-7H5v1.63c3.96 1.28 7.09 4.41 8.37 8.37H19V7zM1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z';

export function CastGlyph({
  size = 18,
  color,
  connected = false,
}: {
  size?: number;
  color: string;
  connected?: boolean;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={connected ? CAST_CONNECTED : CAST} fill={color} />
    </Svg>
  );
}
