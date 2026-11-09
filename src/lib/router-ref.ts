/**
 * The router's navigation container ref, readable outside React. expo-router 58 removed
 * its global router store (`store.navigationRef`, `store.state`), and its only public
 * read of the container is a hook (`useNavigationContainerRef`); a press handler, a
 * startup path or a test must read the state at call time without subscribing. This is
 * the same ref the router mounts its container with and its own testing library reads,
 * so it is a deep import: this module is the one place that names the path, and the
 * route-tree tests pin it.
 */
export { navigationRef } from 'expo-router/build/global-state/navigationRef';
