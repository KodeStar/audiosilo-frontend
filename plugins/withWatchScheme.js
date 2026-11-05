const fs = require('fs');
const path = require('path');
const { withFinalizedMod, IOSConfig } = require('expo/config-plugins');

/**
 * Write a shared `AudioSiloWatch` scheme that builds ONLY the watch app.
 *
 * `@bacons/apple-targets` adds the watch target but no scheme, and the scheme Xcode makes up
 * for it also builds the iPhone app (which embeds the watch app), so
 * `xcodebuild -scheme AudioSiloWatch -sdk watchsimulator` compiled every pod for watchOS and
 * failed in glog (`syscall` is unavailable on watchOS). The watch target links no pods, so a
 * scheme with just the watch target builds, runs in a watch simulator, and archives on its own;
 * the iPhone app's `AudioSilo` scheme still embeds the watch app as before.
 *
 * A finalized mod, so it runs after every project mod has written the pbxproj (the watch
 * target's id is made fresh on each prebuild) and its place in `app.json` does not matter.
 */
const SCHEME = 'AudioSiloWatch';
const TARGET = 'AudioSiloWatch';

function ref({ targetId, productName, container }) {
  return `<BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "${targetId}"
               BuildableName = "${productName}"
               BlueprintName = "${TARGET}"
               ReferencedContainer = "container:${container}">
            </BuildableReference>`;
}

/** The scheme's XML for the watch target `targetId`. */
function watchScheme(opts) {
  const r = ref(opts);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "2600"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            ${r}
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      shouldUseLaunchSchemeArgsEnv = "YES">
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         ${r}
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = ""
      useCustomWorkingDirectory = "NO"
      debugDocumentVersioning = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         ${r}
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;
}

/** The watch target's id and product name in a parsed project (`xcode` package), or null. */
function findWatchTarget(project) {
  const targets = project.pbxNativeTargetSection();
  for (const [id, t] of Object.entries(targets)) {
    if (typeof t !== 'object' || id.endsWith('_comment')) continue;
    if (String(t.name).replace(/"/g, '') !== TARGET) continue;
    return {
      targetId: id,
      productName: String(t.productReference_comment || `${TARGET}.app`).replace(/"/g, ''),
    };
  }
  return null;
}

const withWatchScheme = (config) =>
  withFinalizedMod(config, [
    'ios',
    async (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const project = IOSConfig.XcodeUtils.getPbxproj(cfg.modRequest.projectRoot);
      const target = findWatchTarget(project);
      if (!target) return cfg;
      const xcodeproj = IOSConfig.Paths.getXcodeProjectPath(cfg.modRequest.projectRoot);
      const dir = path.join(xcodeproj, 'xcshareddata', 'xcschemes');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${SCHEME}.xcscheme`),
        watchScheme({ ...target, container: path.relative(root, xcodeproj) }),
      );
      return cfg;
    },
  ]);

module.exports = withWatchScheme;
module.exports.watchScheme = watchScheme;
module.exports.findWatchTarget = findWatchTarget;
