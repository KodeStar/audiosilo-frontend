import { render, screen } from '@testing-library/react-native';

import { Badge } from './badge';
import { Separator } from './separator';
import { Text } from './text';

function mount(ui: React.ReactElement) {
  return render(ui);
}

describe('Badge', () => {
  it('tints its label to the tone (status = colour + word)', async () => {
    await mount(
      <Badge variant="success">
        <Text>Finished</Text>
      </Badge>,
    );
    expect(String(screen.getByText('Finished').props.className)).toContain('text-success');
  });

  it('defaults to the quiet secondary tone', async () => {
    await mount(
      <Badge testID="b">
        <Text>Book 3</Text>
      </Badge>,
    );
    expect(String(screen.getByTestId('b').props.className)).toContain('bg-secondary');
  });
});

describe('Separator', () => {
  it('is a decorative hairline', async () => {
    await mount(<Separator testID="sep" />);
    // Decorative: hidden from screen readers, so the query has to ask for hidden nodes.
    const sep = screen.getByTestId('sep', { includeHiddenElements: true });
    expect(String(sep.props.className)).toContain('bg-border');
  });
});
