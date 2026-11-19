import { FlashList } from '@shopify/flash-list';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { settleFlashList } from '@/testing/flash-list';

// Guards patches/@shopify+flash-list+*.patch: on the web, react-native-web reports an item's
// onLayout a tick after the resize, so once the data shrank (Home's Continue rail as a book
// is finished) the item the data dropped could still report its size, and FlashList's size
// check looked up a layout it no longer had: "index out of bounds, not enough layouts". The
// patch skips an index past the data.

type LayoutHandler = (e: { nativeEvent: { layout: object } }) => void;

const list = (data: string[]) => (
  <FlashList
    horizontal
    data={data}
    keyExtractor={(s) => s}
    renderItem={({ item }) => <Text>{item}</Text>}
  />
);

const size = { nativeEvent: { layout: { x: 0, y: 0, width: 50, height: 50 } } };

/** The onLayout of the nearest view around `text` that has one: its FlashList cell. */
function cellOnLayout(text: string): LayoutHandler {
  let node = screen.getByText(text).parent;
  while (node && typeof node.props.onLayout !== 'function') node = node.parent;
  if (!node) throw new Error(`no cell around ${text}`);
  return node.props.onLayout as LayoutHandler;
}

describe('FlashList size check (patched)', () => {
  it('ignores a size an item reports after the data dropped it', async () => {
    const view = await render(list(['a', 'b', 'c']));
    await settleFlashList();
    const late = cellOnLayout('c');
    await view.rerender(list(['a', 'b']));
    await settleFlashList();
    // react-native-web's late report for the dropped third item.
    await expect(act(async () => late(size))).resolves.toBeUndefined();
  });
});
