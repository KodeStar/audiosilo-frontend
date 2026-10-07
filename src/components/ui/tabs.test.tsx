import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { Tabs, TabsContent, TabsList, TabsTrigger, tabsScrollCue } from './tabs';
import { Text } from './text';

const TABS = ['chapters', 'notes', 'series'] as const;

function Harness({ scrollable }: { scrollable?: boolean }) {
  const [tab, setTab] = useState<string>('notes');
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList scrollable={scrollable}>
        {TABS.map((v) => (
          <TabsTrigger key={v} value={v}>
            <Text>{v}</Text>
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={tab}>
        <Text>{`panel:${tab}`}</Text>
      </TabsContent>
    </Tabs>
  );
}

function mount(ui: React.ReactElement) {
  return render(ui);
}

describe('Tabs', () => {
  it('renders a tab per option with exactly one selected, and its panel', async () => {
    await mount(<Harness />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1);
    expect(screen.getByText('panel:notes')).toBeTruthy();
  });

  it('switches the panel when another tab is pressed', async () => {
    await mount(<Harness />);
    await fireEvent.press(screen.getByText('series'));
    expect(screen.getByRole('tab', { name: 'series', selected: true })).toBeTruthy();
    expect(screen.getByText('panel:series')).toBeTruthy();
  });

  it('keeps tab semantics in a horizontally scrolling row (the book tabs)', async () => {
    await mount(<Harness scrollable />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('underlines the active tab in ink', async () => {
    await mount(<Harness />);
    const active = screen.getByRole('tab', { name: 'notes' });
    expect(String(active.props.className)).toContain('border-foreground');
  });

  // HORIZONTAL_SCROLLER: on native a growing row would swallow the column under it.
  it('keeps a scrolling tab row to its own height (no native flex-grow)', async () => {
    await mount(<Harness scrollable />);
    const row = screen.getByTestId('tabs-scroller');
    expect(StyleSheet.flatten(row.props.style)?.flexGrow).toBe(0);
  });

  it('says nothing while every tab fits, and pages an overflowing row', async () => {
    await mount(<Harness scrollable />);
    expect(screen.queryByTestId('tabs-scroll-cue')).toBeNull();
    const row = screen.getByTestId('tabs-scroller');
    await act(async () => {
      fireEvent(row, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 380, height: 42 } } });
      fireEvent(row, 'contentSizeChange', 492, 42);
    });
    // The last tabs are out of sight: a chevron says so, and is a real labelled button.
    expect(screen.getByRole('button', { name: 'More tabs' })).toBeTruthy();
    await act(async () => {
      fireEvent.scroll(row, { nativeEvent: { contentOffset: { x: 112, y: 0 } } });
    });
    expect(screen.getByRole('button', { name: 'Earlier tabs' })).toBeTruthy();
  });
});

describe('tabsScrollCue', () => {
  it('is none until measured and while the tabs fit', () => {
    expect(tabsScrollCue({ view: 0, content: 500, x: 0 })).toBeNull();
    expect(tabsScrollCue({ view: 380, content: 380, x: 0 })).toBeNull();
  });

  it('pages forward until the end, then back', () => {
    expect(tabsScrollCue({ view: 380, content: 492, x: 0 })).toBe('forward');
    expect(tabsScrollCue({ view: 380, content: 492, x: 60 })).toBe('forward');
    expect(tabsScrollCue({ view: 380, content: 492, x: 112 })).toBe('back');
  });
});
