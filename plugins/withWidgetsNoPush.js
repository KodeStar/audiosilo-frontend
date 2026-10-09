const { withEntitlementsPlist } = require('expo/config-plugins');

/**
 * Keep the app's entitlements free of `aps-environment`, which expo-widgets 56 adds
 * unconditionally (its `withPushNotifications` sets it whether or not
 * `enablePushNotifications` is on).
 *
 * AudioSilo sends no push notifications and drives its Live Activity from the app, not
 * over APNs, so the entitlement would only add the Push Notifications capability to the
 * App ID and every provisioning profile (dev and distribution) for nothing - and a build
 * signed with a profile that lacks it fails. Remove this plugin if the app ever adopts
 * push (expo-notifications, or `enablePushNotifications` for remote Live Activity updates).
 *
 * ORDER: mods run in REVERSE plugin order, so this must be listed BEFORE `expo-widgets`
 * in `app.json` to run after it (like `withXcode26SwiftUICoreFix`).
 */
function stripPushEntitlement(entitlements) {
  delete entitlements['aps-environment'];
  return entitlements;
}

const withWidgetsNoPush = (config) =>
  withEntitlementsPlist(config, (cfg) => {
    stripPushEntitlement(cfg.modResults);
    return cfg;
  });

module.exports = withWidgetsNoPush;
module.exports.stripPushEntitlement = stripPushEntitlement;
