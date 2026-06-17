import { Slot } from 'expo-router';

import { AppShell } from '@/components/layout/app-shell';

export default function AppGroupLayout() {
  return (
    <AppShell>
      <Slot />
    </AppShell>
  );
}
