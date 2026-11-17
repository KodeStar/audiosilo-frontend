import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { type ReactElement, useState } from 'react';
import { Platform, Text } from 'react-native';

import { mountWithPortal } from '@/testing/render-overlay';

import { AlertDialog, AlertDialogContent, AlertDialogTitle } from './alert-dialog';
import { Button } from './button';
import { Dialog, DialogContent, DialogTitle } from './dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { behindModalProps, useBehindModalProps, useModalLayer } from './modal-layer';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

function Layer({ active }: { active: boolean }) {
  useModalLayer(active);
  return null;
}

function Page() {
  const props = useBehindModalProps();
  return (
    <Text testID="page" {...props}>
      page
    </Text>
  );
}

describe('modal layers (fe#267)', () => {
  const prevOS = Platform.OS;
  afterEach(() => {
    Platform.OS = prevOS;
  });

  it('hides the page behind from VoiceOver and TalkBack while any layer is open', async () => {
    const view = await render(
      <>
        <Page />
        <Layer active={false} />
        <Layer active={false} />
      </>,
    );
    expect(screen.getByTestId('page', { includeHiddenElements: true })).toHaveProp(
      'importantForAccessibility',
      'auto',
    );
    await act(async () => {
      view.rerender(
        <>
          <Page />
          <Layer active />
          <Layer active />
        </>,
      );
    });
    expect(screen.getByTestId('page', { includeHiddenElements: true })).toHaveProp(
      'importantForAccessibility',
      'no-hide-descendants',
    );
    expect(screen.getByTestId('page', { includeHiddenElements: true })).toHaveProp(
      'accessibilityElementsHidden',
      true,
    );
    // One of two closes: the other still holds the page hidden.
    await act(async () => {
      view.rerender(
        <>
          <Page />
          <Layer active />
          <Layer active={false} />
        </>,
      );
    });
    expect(screen.getByTestId('page', { includeHiddenElements: true })).toHaveProp(
      'importantForAccessibility',
      'no-hide-descendants',
    );
    await act(async () => {
      view.rerender(
        <>
          <Page />
          <Layer active={false} />
          <Layer active={false} />
        </>,
      );
    });
    expect(screen.getByTestId('page', { includeHiddenElements: true })).toHaveProp(
      'importantForAccessibility',
      'auto',
    );
  });

  it('adds nothing on the web, where the dialog is aria-modal', () => {
    Platform.OS = 'web';
    expect(behindModalProps(true)).toEqual({});
    Platform.OS = 'android';
    expect(behindModalProps(true)).toEqual({
      importantForAccessibility: 'no-hide-descendants',
      accessibilityElementsHidden: true,
    });
  });
});

describe('portaled overlays are modal layers (fe#305)', () => {
  const pageHidden = () =>
    screen.getByTestId('page', { includeHiddenElements: true }).props
      .accessibilityElementsHidden === true;

  function DialogHarness({ alert }: { alert?: boolean }) {
    const [open, setOpen] = useState(false);
    const body = alert ? (
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>Remove</AlertDialogTitle>
          <Button title="Done" onPress={() => setOpen(false)} />
        </AlertDialogContent>
      </AlertDialog>
    ) : (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Rename</DialogTitle>
          <Button title="Done" onPress={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    );
    return (
      <>
        <Page />
        <Button title="Open" onPress={() => setOpen(true)} />
        {body}
      </>
    );
  }

  it.each([
    ['a Dialog', <DialogHarness key="d" />],
    ['an AlertDialog', <DialogHarness key="a" alert />],
  ])('%s hides the page behind only while open', async (_kind, ui: ReactElement) => {
    await mountWithPortal(ui);
    expect(pageHidden()).toBe(false);
    await fireEvent.press(screen.getByText('Open'));
    expect(pageHidden()).toBe(true);
    await fireEvent.press(screen.getByText('Done'));
    expect(pageHidden()).toBe(false);
  });

  it('a Select hides the page behind only while its list is open', async () => {
    function Harness() {
      const [value, setValue] = useState({ value: 'a', label: 'First' });
      return (
        <>
          <Page />
          <Select value={value} onValueChange={(o) => o && setValue(o)}>
            <SelectTrigger accessibilityLabel="Pick">
              <SelectValue placeholder="Pick one" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="a" label="First" />
              <SelectItem value="b" label="Second" />
            </SelectContent>
          </Select>
        </>
      );
    }
    await mountWithPortal(<Harness />);
    expect(pageHidden()).toBe(false);
    await fireEvent.press(screen.getByRole('combobox', { name: 'Pick' }));
    expect(pageHidden()).toBe(true);
    await fireEvent.press(screen.getByText('Second'));
    expect(pageHidden()).toBe(false);
  });

  it('a menu hides the page behind only while open', async () => {
    await mountWithPortal(
      <>
        <Page />
        <DropdownMenu>
          <DropdownMenuTrigger accessibilityLabel="More">
            <Text>More</Text>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem icon="bookmark">
              <Text>Bookmark</Text>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>,
    );
    expect(pageHidden()).toBe(false);
    await fireEvent.press(screen.getByLabelText('More'));
    expect(pageHidden()).toBe(true);
    await fireEvent.press(screen.getByText('Bookmark'));
    expect(pageHidden()).toBe(false);
  });
});
