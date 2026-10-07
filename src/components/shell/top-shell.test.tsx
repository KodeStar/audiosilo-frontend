import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { useIsTopShell } from './top-shell';

function Shell({ name }: { name: string }) {
  return <Text testID={name}>{useIsTopShell() ? 'top' : 'under'}</Text>;
}

// Two stacked `(app)` shells rendered every player dialog twice and ran every key twice:
// only the newest (top) shell may host the singletons.
it('makes the newest shell the only top one, and hands back when it goes', async () => {
  const view = await render(<Shell name="first" />);
  expect(screen.getByTestId('first')).toHaveTextContent('top');
  await view.rerender(
    <>
      <Shell name="first" />
      <Shell name="second" />
    </>,
  );
  expect(screen.getByTestId('first')).toHaveTextContent('under');
  expect(screen.getByTestId('second')).toHaveTextContent('top');
  await view.rerender(<Shell name="first" />);
  expect(screen.getByTestId('first')).toHaveTextContent('top');
  await act(async () => view.unmount());
});
