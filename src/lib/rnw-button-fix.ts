// Native no-op. The web build (`rnw-button-fix.web.ts`) patches react-native-web's
// role->element mapping so `role="button"` renders as `<div role="button">` instead
// of a real `<button>` (which nests illegally and hits an older-Safari flex bug), and
// its press responder so Space activates role-bearing controls (tab, radio, switch...).
// There is no DOM on native, so there is nothing to patch here.
export {};
