import { render, screen } from '@testing-library/react-native';
import { memo } from 'react';
import { Text } from 'react-native';

import { mocksChanged, useMockedHook } from './mock-hooks';

let answer = 'first';
let plainAnswer = 'first';

// A child memoised against its props, as the React Compiler builds every element.
const Reader = memo(function Reader() {
  useMockedHook();
  return <Text testID="reader">{answer}</Text>;
});
const PlainReader = memo(function PlainReader() {
  return <Text testID="plain">{plainAnswer}</Text>;
});
const Page = () => (
  <>
    <Reader />
    <PlainReader />
  </>
);

it("re-renders a mocked hook's memoised caller when the test changes its answer", async () => {
  await render(<Page />);
  answer = 'second';
  plainAnswer = 'second';
  // A rerender with the same props reaches neither memoised child.
  await screen.rerender(<Page />);
  expect(screen.getByTestId('reader').props.children).toBe('first');
  expect(screen.getByTestId('plain').props.children).toBe('first');
  // Only the one that reads through the mocked hook follows the change.
  await mocksChanged();
  expect(screen.getByTestId('reader').props.children).toBe('second');
  expect(screen.getByTestId('plain').props.children).toBe('first');
});
