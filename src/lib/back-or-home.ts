import { router } from 'expo-router';

/**
 * Leave a screen the listener can't use here (a link to a server this device no longer
 * knows, another person's book): back where there is a screen to go back to, else Home
 * (a cold link or a reload has nothing under it). `dismissTo`, so a root route on top
 * (the full player) goes too.
 */
export function backOrHome(): void {
  if (router.canGoBack()) router.back();
  else router.dismissTo('/');
}
