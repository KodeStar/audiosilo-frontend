// Native no-op: service workers are a web concept. Metro resolves register-sw.web.ts
// on web and this file on iOS/Android (mirrors src/playback/service.*).
export function registerServiceWorker() {}
