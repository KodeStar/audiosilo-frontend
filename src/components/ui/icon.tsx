import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { faAlarmSnooze } from '@fortawesome/pro-light-svg-icons/faAlarmSnooze';
import { faArrowRotateLeft } from '@fortawesome/pro-light-svg-icons/faArrowRotateLeft';
import { faArrowRotateRight } from '@fortawesome/pro-light-svg-icons/faArrowRotateRight';
import { faBook } from '@fortawesome/pro-light-svg-icons/faBook';
import { faBookmark } from '@fortawesome/pro-light-svg-icons/faBookmark';
import { faCheck } from '@fortawesome/pro-light-svg-icons/faCheck';
import { faChevronDown } from '@fortawesome/pro-light-svg-icons/faChevronDown';
import { faChevronLeft } from '@fortawesome/pro-light-svg-icons/faChevronLeft';
import { faChevronRight } from '@fortawesome/pro-light-svg-icons/faChevronRight';
import { faChevronUp } from '@fortawesome/pro-light-svg-icons/faChevronUp';
import { faCircleStop } from '@fortawesome/pro-light-svg-icons/faCircleStop';
import { faClock } from '@fortawesome/pro-light-svg-icons/faClock';
import { faClockRotateLeft } from '@fortawesome/pro-light-svg-icons/faClockRotateLeft';
import { faDownToLine } from '@fortawesome/pro-light-svg-icons/faDownToLine';
import { faEllipsis } from '@fortawesome/pro-light-svg-icons/faEllipsis';
import { faFolder } from '@fortawesome/pro-light-svg-icons/faFolder';
import { faGear } from '@fortawesome/pro-light-svg-icons/faGear';
import { faHeart } from '@fortawesome/pro-light-svg-icons/faHeart';
import { faHouse } from '@fortawesome/pro-light-svg-icons/faHouse';
import { faList } from '@fortawesome/pro-light-svg-icons/faList';
import { faMagnifyingGlass } from '@fortawesome/pro-light-svg-icons/faMagnifyingGlass';
import { faMinus } from '@fortawesome/pro-light-svg-icons/faMinus';
import { faNoteSticky } from '@fortawesome/pro-light-svg-icons/faNoteSticky';
import { faPlus } from '@fortawesome/pro-light-svg-icons/faPlus';
import { faQrcode } from '@fortawesome/pro-light-svg-icons/faQrcode';
import { faRectangleVerticalHistory } from '@fortawesome/pro-light-svg-icons/faRectangleVerticalHistory';
import { faRightFromBracket } from '@fortawesome/pro-light-svg-icons/faRightFromBracket';
import { faServer } from '@fortawesome/pro-light-svg-icons/faServer';
import { faSliders } from '@fortawesome/pro-light-svg-icons/faSliders';
import { faSpinnerThird } from '@fortawesome/pro-light-svg-icons/faSpinnerThird';
import { faTrashCan } from '@fortawesome/pro-light-svg-icons/faTrashCan';
import { faUser } from '@fortawesome/pro-light-svg-icons/faUser';
import { faWifiSlash } from '@fortawesome/pro-light-svg-icons/faWifiSlash';
import { faXmark } from '@fortawesome/pro-light-svg-icons/faXmark';
import { faBackwardStep } from '@fortawesome/pro-regular-svg-icons/faBackwardStep';
import { faForwardStep } from '@fortawesome/pro-regular-svg-icons/faForwardStep';
import { faCirclePause } from '@fortawesome/pro-solid-svg-icons/faCirclePause';
import { faCirclePlay } from '@fortawesome/pro-solid-svg-icons/faCirclePlay';
import { faHeart as faHeartSolid } from '@fortawesome/pro-solid-svg-icons/faHeart';
import { faPause } from '@fortawesome/pro-solid-svg-icons/faPause';
import { faPlay } from '@fortawesome/pro-solid-svg-icons/faPlay';
import { faTriangle } from '@fortawesome/pro-solid-svg-icons/faTriangle';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { View } from 'react-native';

/**
 * Central icon abstraction. Screens import `<Icon name=... />` from here, never
 * an icon library directly, so the backend stays swappable. Backed by
 * FontAwesome Pro (light for chrome, solid for transport controls).
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
  | 'next'
  | 'prev'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-up'
  | 'spinner'
  | 'circle-stop'
  | 'bookmark'
  | 'clock'
  | 'history'
  | 'notes'
  | 'sliders'
  | 'trash'
  | 'close'
  | 'plus'
  | 'minus'
  | 'ellipsis'
  | 'download'
  | 'sleep'
  | 'book'
  | 'list'
  | 'library'
  | 'qrcode'
  | 'server'
  | 'check'
  | 'offline'
  | 'user'
  | 'heart'
  | 'triangle'
  | 'heart-solid';

const ICONS: Record<IconName, IconDefinition> = {
  home: faHouse,
  folder: faFolder,
  search: faMagnifyingGlass,
  settings: faGear,
  logout: faRightFromBracket,
  play: faPlay,
  triangle: faTriangle,
  pause: faPause,
  'circle-play': faCirclePlay,
  'circle-pause': faCirclePause,
  forward: faArrowRotateRight,
  backward: faArrowRotateLeft,
  next: faForwardStep,
  prev: faBackwardStep,
  'chevron-left': faChevronLeft,
  'chevron-right': faChevronRight,
  'chevron-down': faChevronDown,
  'chevron-up': faChevronUp,
  spinner: faSpinnerThird,
  'circle-stop': faCircleStop,
  bookmark: faBookmark,
  clock: faClock,
  history: faClockRotateLeft,
  notes: faNoteSticky,
  sliders: faSliders,
  trash: faTrashCan,
  close: faXmark,
  plus: faPlus,
  minus: faMinus,
  ellipsis: faEllipsis,
  download: faDownToLine,
  sleep: faAlarmSnooze,
  book: faBook,
  list: faList,
  library: faRectangleVerticalHistory,
  qrcode: faQrcode,
  server: faServer,
  check: faCheck,
  offline: faWifiSlash,
  user: faUser,
  heart: faHeart,
  'heart-solid': faHeartSolid,
};

export type IconProps = {
  name: IconName;
  size?: number;
  color?: string;
  className?: string;
};

export function Icon({ name, size = 20, color = '#9ca3af', className }: IconProps) {
  const icon = <FontAwesomeIcon icon={ICONS[name]} size={size} color={color} />;
  return className ? <View className={className}>{icon}</View> : icon;
}
