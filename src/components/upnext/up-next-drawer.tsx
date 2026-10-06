import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { useCapability } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { UpNextPanel, useQueuedLine } from './up-next-panel';
import { clampDrawerWidth, DRAWER_MAX, DRAWER_MIN } from './up-next-model';
import { closeUpNext, hydrateUpNext, useUpNext } from './up-next-store';
import { useUpNextConnection, useUpNextData } from './use-up-next';

/** One keyboard step of the resize handle (web), in points. */
const KEY_STEP = 20;

/**
 * The desktop Up next drawer (STYLEGUIDE section 8): a column beside the page, between
 * the top chrome and the docked player, 360 wide by default and 300-480 by dragging its
 * left edge (or the arrow keys on the focused edge, web). Hidden with Q, the close
 * button, or the top bar / dock buttons; both its width and whether it is open are
 * remembered on this device. Nothing renders until the server is known to have `queue`.
 */
export function UpNextDrawer() {
  const cid = useUpNextConnection();
  const supported = useCapability('queue', cid);
  const open = useUpNext((s) => s.drawerOpen);
  useEffect(() => {
    void hydrateUpNext();
  }, []);
  if (!open || supported !== true || !cid) return null;
  return <Drawer cid={cid} />;
}

function Drawer({ cid }: { cid: string }) {
  const { t } = useTranslation();
  const width = useUpNext((s) => s.drawerWidth);
  const setWidth = useUpNext((s) => s.setDrawerWidth);
  const data = useUpNextData(cid);
  const subline = useQueuedLine(cid, data.queuedSeconds, data.entries?.length ?? 0);

  // The live width while dragging (UI thread); the store takes it on release.
  const live = useSharedValue(width);
  const start = useSharedValue(width);
  useEffect(() => {
    live.set(width);
  }, [width, live]);
  const resize = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          start.set(live.get());
        })
        .onUpdate((e) => {
          live.set(Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, start.get() - e.translationX)));
        })
        .onEnd(() => {
          runOnJS(setWidth)(live.get());
        }),
    [live, start, setWidth],
  );
  const widthStyle = useAnimatedStyle(() => ({ width: live.get() }));

  const keyboard =
    Platform.OS === 'web'
      ? {
          focusable: true,
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            const delta = e.key === 'ArrowLeft' ? KEY_STEP : e.key === 'ArrowRight' ? -KEY_STEP : 0;
            if (!delta) return;
            e.preventDefault();
            setWidth(clampDrawerWidth(width + delta));
          },
        }
      : {};

  return (
    <Animated.View
      testID="upnext-drawer"
      accessibilityLabel={t('upnext.title')}
      role="complementary"
      style={widthStyle}
      className="border-l border-border bg-card"
    >
      <GestureDetector gesture={resize}>
        <View
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={DRAWER_MIN}
          aria-valuemax={DRAWER_MAX}
          aria-valuenow={width}
          accessibilityLabel={t('upnext.resize')}
          {...keyboard}
          className={cn(
            'absolute bottom-0 left-[-4px] top-0 z-10 w-2',
            Platform.select({
              web: 'cursor-col-resize outline-none hover:bg-brand/40 focus-visible:bg-brand/60',
            }),
          )}
        />
      </GestureDetector>
      <View className="h-[64px] flex-row items-center justify-between gap-2 border-b border-border pl-[18px] pr-3">
        <View className="flex-1 gap-0.5">
          <Text variant="title" accessibilityRole="header">
            {t('upnext.title')}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {subline}
          </Text>
        </View>
        <Button
          variant="ghost"
          size="icon"
          icon="close"
          accessibilityLabel={t('upnext.hide')}
          onPress={closeUpNext}
        />
      </View>
      <ScrollView className="flex-1" contentContainerClassName="px-3 pb-5 pt-3">
        <UpNextPanel cid={cid} data={data} />
      </ScrollView>
    </Animated.View>
  );
}
