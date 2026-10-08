// The app's entry (package.json `main`). The car's headless task (Android) is registered
// first, so a JS runtime the playback service boots without an activity finds it; then Expo
// Router's own entry registers the app as before. On iOS and the web the first import is
// empty (Metro picks `register-car-task.ts` there).
import './src/car/register-car-task';
import 'expo-router/entry';
