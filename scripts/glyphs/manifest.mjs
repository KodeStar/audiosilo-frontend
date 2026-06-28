// Single source of truth for the app's UI glyphs (the `<Icon name="…"/>` set).
//
// Each entry maps an app-facing icon name to a FontAwesome Pro 7 icon. This file
// - plus the generator next to it - is the ONLY place AudioSilo touches
// FontAwesome. The app itself ships the resolved SVG path data
// (src/components/ui/icon-data.ts) and has no FontAwesome dependency, so building
// the app needs no FontAwesome Pro token.
//
// To add / change an icon: edit this list, then regenerate the vendored data:
//   cd scripts/glyphs && npm install && npm run gen
// (see scripts/glyphs/README.md - the npm install needs your FA Pro token).
//
// weight → FontAwesome Pro package:
//   light   → @fortawesome/pro-light-svg-icons   (chrome / navigation)
//   regular → @fortawesome/pro-regular-svg-icons
//   solid   → @fortawesome/pro-solid-svg-icons    (transport controls)

/** @type {Array<[name: string, weight: 'light'|'regular'|'solid', faName: string]>} */
export const GLYPHS = [
  ['home', 'light', 'faHouse'],
  ['folder', 'light', 'faFolder'],
  ['search', 'light', 'faMagnifyingGlass'],
  ['settings', 'light', 'faGear'],
  ['logout', 'light', 'faRightFromBracket'],
  ['play', 'solid', 'faPlay'],
  ['pause', 'solid', 'faPause'],
  ['circle-play', 'solid', 'faCirclePlay'],
  ['triangle', 'solid', 'faTriangle'],
  ['next', 'regular', 'faForwardStep'],
  ['prev', 'regular', 'faBackwardStep'],
  ['chevron-right', 'light', 'faChevronRight'],
  ['chevron-down', 'light', 'faChevronDown'],
  ['chevron-up', 'light', 'faChevronUp'],
  ['circle-stop', 'light', 'faCircleStop'],
  ['bookmark', 'light', 'faBookmark'],
  ['clock', 'light', 'faClock'],
  ['history', 'light', 'faClockRotateLeft'],
  ['notes', 'light', 'faNoteSticky'],
  ['trash', 'light', 'faTrashCan'],
  ['close', 'light', 'faXmark'],
  ['plus', 'light', 'faPlus'],
  ['minus', 'light', 'faMinus'],
  ['ellipsis', 'light', 'faEllipsis'],
  ['download', 'light', 'faDownToLine'],
  ['sleep', 'light', 'faAlarmSnooze'],
  ['book', 'light', 'faBook'],
  ['list', 'light', 'faList'],
  ['library', 'light', 'faRectangleVerticalHistory'],
  ['qrcode', 'light', 'faQrcode'],
  ['server', 'light', 'faServer'],
  ['check', 'light', 'faCheck'],
  ['offline', 'light', 'faWifiSlash'],
  ['user', 'light', 'faUser'],
  ['heart', 'light', 'faHeart'],
  ['airplay', 'light', 'faAirplayAudio'],
  ['heart-solid', 'solid', 'faHeart'],
];
