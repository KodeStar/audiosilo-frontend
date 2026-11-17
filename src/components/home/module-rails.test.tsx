import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import type { Capabilities } from '@/api/types';

// Which servers have the module on, by connection id.
let mockCaps: Record<string, Partial<Capabilities> | undefined> = {};
jest.mock('@/api/hooks', () => ({ useCapabilitiesAll: () => mockCaps }));
// Active when some server has it on (`useActiveModules` has its own suite).
jest.mock('@/modules/registry', () => ({
  ...jest.requireActual('@/modules/registry'),
  useActiveModules: (list: readonly { id: string }[]) =>
    list.filter((m) => Object.values(mockCaps).some((c) => c?.[m.id as keyof Capabilities])),
}));

/* eslint-disable import/first */
import type { PlayerModule } from '@/modules/registry';
import type { Connection } from '@/stores/session';

import { ModuleRails } from './module-rails';
/* eslint-enable import/first */

const conn = (id: string) => ({ id, name: id, serverUrl: `https://${id}` }) as Connection;
const FAKE: PlayerModule = {
  id: 'contributions',
  homeRails: ({ connections }) => (
    <Text>{`Module rail: ${connections.map((c) => c.id).join(',')}`}</Text>
  ),
};

// fe#159: a module's rails get only the servers that have it on.
it('hands a module its rails with only the connections that have it on', async () => {
  mockCaps = { a: { contributions: false }, b: { contributions: true }, c: undefined };
  await render(<ModuleRails connections={[conn('a'), conn('b'), conn('c')]} modules={[FAKE]} />);
  expect(screen.getByText('Module rail: b')).toBeTruthy();
});

it('renders nothing for a module no server has on', async () => {
  mockCaps = { a: { contributions: false } };
  await render(<ModuleRails connections={[conn('a')]} modules={[FAKE]} />);
  expect(screen.queryByText(/Module rail/)).toBeNull();
});
