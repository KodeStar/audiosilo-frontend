/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
// The standalone Apple Watch app (Track W3a): its own device, token, outbox and downloads,
// talking to the server directly. `@bacons/apple-targets` (last in app.json's plugins) adds this
// folder to the Xcode project as the AudioSiloWatch target at prebuild; it edits only the
// project, never the AppDelegate, so `withCarPlay`'s exact-text rewrite still applies. System
// frameworks only (apple-targets #171): no Swift package or pod on this target. Core/ is
// Foundation only and is also built by watch-core/ for its tests (`npm run test:watch`).
module.exports = () => ({
  type: 'watch',
  name: 'AudioSiloWatch',
  displayName: 'AudioSilo',
  bundleIdentifier: '.watchkitapp',
  deploymentTarget: '11.0',
  icon: '../../assets/images/icon.png',
  frameworks: ['SwiftUI', 'AVFoundation', 'MediaPlayer', 'WatchConnectivity', 'WatchKit'],
});
