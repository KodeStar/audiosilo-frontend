import { fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
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
});
