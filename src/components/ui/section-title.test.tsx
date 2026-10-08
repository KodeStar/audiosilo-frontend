import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { SectionTitle } from './section-title';

describe('SectionTitle', () => {
  it('heads a section with its title and the line under it', async () => {
    await render(<SectionTitle title="Your devices" sub="Signed in to this server" />);
    expect(screen.getByRole('header', { name: 'Your devices' })).toBeTruthy();
    expect(screen.getByText('Signed in to this server')).toBeTruthy();
  });

  it('puts an action beside the title', async () => {
    await render(<SectionTitle title="API keys" action={<Text>Create a key</Text>} />);
    expect(screen.getByText('Create a key')).toBeTruthy();
    expect(screen.getByRole('header', { name: 'API keys' })).toBeTruthy();
  });
});
