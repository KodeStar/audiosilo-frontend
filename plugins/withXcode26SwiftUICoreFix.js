const { withXcodeProject, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Work around the Xcode 26 / iOS 26 SDK "SwiftUICore" linker failure.
 *
 * On the iOS 26 SDK, `import SwiftUI` (pulled in transitively by ExpoModulesCore, so
 * effectively every source-compiled Expo module, plus the app's own generated
 * ExpoModulesProvider) makes the Swift compiler emit an autolink for BOTH `SwiftUI`
 * and the newly-split private `SwiftUICore` framework. Xcode 26's linker then refuses
 * that direct SwiftUICore link because the product isn't on SwiftUICore.tbd's
 * `allowable_clients` list (which allows SwiftUI and a few Apple frameworks, not apps):
 *
 *   ld: cannot link directly with 'SwiftUICore' because product being built is not an
 *   allowed client of it   ->   symbol(s) not found for architecture arm64 (exit 65)
 *
 * Neither implicit nor explicit (`-weak_framework`) direct linking is permitted, so the
 * fix is to SUPPRESS the direct SwiftUICore autolink and let its symbols resolve through
 * SwiftUI's re-export (SwiftUI IS an allowed client and re-exports SwiftUICore). That
 * needs `-disable-autolink-framework SwiftUICore` on every Swift-compiling target:
 *  - the app target (this plugin's withXcodeProject mod), and
 *  - every pod target (the Podfile post_install loop injected below).
 *
 * Also sets `ENABLE_DEBUG_DYLIB = NO` on the app target: Xcode 26's Debug build otherwise
 * links `<App>.debug.dylib`, whose name isn't an allowed client either. RN apps don't use
 * SwiftUI previews, so disabling the debug dylib is side-effect-free.
 *
 * ios/ is gitignored (CNG), so this lives in a config plugin to survive `expo prebuild`
 * rather than as a raw pbxproj/Podfile edit.
 */

const SWIFT_FLAG = "-Xfrontend -disable-autolink-framework -Xfrontend SwiftUICore";

// --- App target: pbxproj build settings -------------------------------------------
function patchAppBuildSettings(buildSettings) {
  buildSettings.ENABLE_DEBUG_DYLIB = "NO";
  let flags = buildSettings.OTHER_SWIFT_FLAGS;
  if (flags == null) flags = '"$(inherited)"';
  if (Array.isArray(flags)) flags = flags.join(" ");
  if (flags.includes("SwiftUICore")) return; // already patched
  // pbxproj wants the whole value quoted since it contains spaces.
  buildSettings.OTHER_SWIFT_FLAGS = `"${flags.replace(/^"|"$/g, "")} ${SWIFT_FLAG}"`;
}

const withAppTargetFix = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key in configurations) {
      const entry = configurations[key];
      if (entry && typeof entry === "object" && entry.buildSettings) {
        patchAppBuildSettings(entry.buildSettings);
      }
    }
    return cfg;
  });

// --- Pod targets: inject an OTHER_SWIFT_FLAGS loop into the Podfile post_install ----
const POD_MARKER = "# xcode26-swiftuicore-fix";
const POD_SNIPPET = `    ${POD_MARKER}
    installer.pods_project.targets.each do |pod_target|
      pod_target.build_configurations.each do |bc|
        f = bc.build_settings['OTHER_SWIFT_FLAGS'] || '$(inherited)'
        f = f.join(' ') if f.is_a?(Array)
        unless f.include?('SwiftUICore')
          bc.build_settings['OTHER_SWIFT_FLAGS'] = "#{f} ${SWIFT_FLAG}"
        end
      end
    end
`;

const withPodfileFix = (config) =>
  withDangerousMod(config, [
    "ios",
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      let contents = fs.readFileSync(podfile, "utf8");
      if (!contents.includes(POD_MARKER)) {
        contents = contents.replace(
          /( *post_install do \|installer\|\n)/,
          `$1${POD_SNIPPET}`,
        );
        fs.writeFileSync(podfile, contents);
      }
      return cfg;
    },
  ]);

module.exports = (config) => withPodfileFix(withAppTargetFix(config));
