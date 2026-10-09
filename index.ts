// The app's entry (package.json `main`). The car's start is registered first: on Android the
// headless task a JS runtime the playback service boots without an activity must find; on
// iOS the CarPlay connection listener, which starts the car's work without the React tree (a
// CarPlay-first launch never renders it, see `startCarWork`). Then Expo Router's own entry
// registers the app as before. On the web the first import is empty.
import './src/car/register-car-task';
import 'expo-router/entry';
