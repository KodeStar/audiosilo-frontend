import { AppRegistry } from 'react-native';

/**
 * Register the car's headless task (`AudiosiloCar`) at the entry, before Expo Router's: the
 * playback service may boot this JS runtime with no activity just to run it. The task's code
 * is loaded only when it runs, so a normal launch evaluates nothing more than before. The
 * name is the contract with the service (`HeadlessJsTaskContext`, section 2.5).
 */
AppRegistry.registerHeadlessTask('AudiosiloCar', () => async () => {
  const { runCarTask } = await import('./car-task');
  await runCarTask();
});
