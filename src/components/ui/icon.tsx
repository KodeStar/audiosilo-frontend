import { View } from 'react-native';

/**
 * Central icon abstraction. Every screen imports `<Icon name=... />` from here,
 * never an icon library directly — so switching the icon backend is a one-file
 * change.
 *
 * TODO(fontawesome): once the FontAwesome Pro npm token is configured and the
 * `@fortawesome/*` packages are installed, replace the placeholder body below
 * with `<FontAwesomeIcon icon={ICONS[name]} size={size} color={color} />` and
 * fill in the ICONS map. The IconName union and component API stay identical,
 * so no consumer changes.
 */
export type IconName =
  | 'home'
  | 'folder'
  | 'search'
  | 'settings'
  | 'logout'
  | 'play'
  | 'pause'
  | 'circle-play'
  | 'circle-pause'
  | 'forward'
  | 'backward'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'spinner'
  | 'bookmark'
  | 'clock'
  | 'sliders'
  | 'trash'
  | 'close'
  | 'plus'
  | 'minus'
  | 'download'
  | 'sleep'
  | 'book'
  | 'list'
  | 'qrcode'
  | 'server'
  | 'check'
  | 'user';

export type IconProps = {
  name: IconName;
  size?: number;
  color?: string;
  className?: string;
};

export function Icon({ name, size = 20, color = '#9ca3af', className }: IconProps) {
  // Placeholder rendering until FontAwesome Pro is wired in. Renders a sized,
  // outlined square so layouts are correct ahead of real glyphs.
  return (
    <View
      accessibilityLabel={name}
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(2, size * 0.18),
        borderWidth: 1.5,
        borderColor: color,
        opacity: 0.55,
      }}
    />
  );
}
