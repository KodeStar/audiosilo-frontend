import { act, render, screen } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';

import { behindModalProps, useBehindModalProps, useModalLayer } from './modal-layer';

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
