import { render, renderHook, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import type { Capabilities } from '@/api/types';

// The player's modules (Bridge Phase 2a): which are on, across the person's servers or on
// one, and the slot wrapper that asks nothing while there are none.

let mockAll: Record<string, Capabilities | undefined> = {};
const mockCapabilitiesAll = jest.fn(() => mockAll);
const mockServerInfo = jest.fn((cid: string) => ({
  data: mockAll[cid] ? { capabilities: mockAll[cid] } : undefined,
}));
jest.mock('@/api/hooks', () => ({
  ...jest.requireActual('@/api/hooks'),
  useCapabilitiesAll: () => mockCapabilitiesAll(),
  useServerInfo: (cid: string) => mockServerInfo(cid),
}));

/* eslint-disable import/first */
import { WithActiveModules } from './active-modules';
import {
  activeModules,
  modulesOn,
  NO_MODULES,
  PLAYER_MODULES,
  type PlayerModule,
  useActiveModules,
  useModulesOn,
} from './registry';
/* eslint-enable import/first */

const caps = (flags: Record<string, boolean>) => flags as unknown as Capabilities;
const CONTRIB: PlayerModule = { id: 'contributions' };
// A second module: only `contributions` is a module's flag so far.
const OTHER = { id: 'other' } as unknown as PlayerModule;

beforeEach(() => {
  jest.clearAllMocks();
  mockAll = {};
});

describe('PLAYER_MODULES', () => {
  it('is empty in Phase 2a: no module reaches the player yet', () => {
    expect(PLAYER_MODULES).toEqual([]);
  });
});

describe('activeModules', () => {
  it('is on when ANY server has the flag, in registry order', () => {
    const all = {
      a: caps({ contributions: false, other: true }),
      b: caps({ contributions: true }),
    };
    expect(activeModules([CONTRIB, OTHER], all)).toEqual([CONTRIB, OTHER]);
    expect(activeModules([OTHER, CONTRIB], all)).toEqual([OTHER, CONTRIB]);
  });

  it('is off while every server lacks the flag or is still unknown', () => {
    expect(activeModules([CONTRIB], { a: caps({ contributions: false }), b: undefined })).toBe(
      NO_MODULES,
    );
    // An older server never sends the flag.
    expect(activeModules([CONTRIB], { a: caps({}) })).toBe(NO_MODULES);
    expect(activeModules([CONTRIB], {})).toBe(NO_MODULES);
  });
});

describe('modulesOn', () => {
  it("counts only the one server's flags", () => {
    expect(modulesOn([CONTRIB, OTHER], caps({ contributions: true }))).toEqual([CONTRIB]);
    expect(modulesOn([CONTRIB], caps({ contributions: false }))).toBe(NO_MODULES);
    expect(modulesOn([CONTRIB], undefined)).toBe(NO_MODULES);
  });
});

describe('useActiveModules', () => {
  it("follows the person's servers as they answer", async () => {
    mockAll = { a: caps({ contributions: false }), b: undefined };
    const { result, rerender } = await renderHook(() => useActiveModules([CONTRIB, OTHER]));
    expect(result.current).toEqual([]);
    // The second server answers with the module on: one is enough.
    mockAll = { a: caps({ contributions: false }), b: caps({ contributions: true }) };
    await rerender({});
    expect(result.current).toEqual([CONTRIB]);
  });

  it('keeps its answer while nothing changed', async () => {
    // The same answer object each render, as useQueries' `combine` keeps it.
    mockAll = { a: caps({ contributions: true }) };
    const list = [CONTRIB];
    const { result, rerender } = await renderHook(() => useActiveModules(list));
    const first = result.current;
    await rerender({});
    expect(result.current).toBe(first);
  });

  it('defaults to the registry, which has nothing on', async () => {
    mockAll = { a: caps({ contributions: true }) };
    const { result } = await renderHook(() => useActiveModules());
    expect(result.current).toEqual([]);
  });
});

describe('useModulesOn', () => {
  it("reads only the given connection's server", async () => {
    mockAll = { a: caps({ contributions: false }), b: caps({ contributions: true }) };
    const onA = await renderHook(() => useModulesOn('a', [CONTRIB]));
    expect(onA.result.current).toEqual([]);
    const onB = await renderHook(() => useModulesOn('b', [CONTRIB]));
    expect(onB.result.current).toEqual([CONTRIB]);
  });
});

describe('WithActiveModules', () => {
  const ids = (active: readonly PlayerModule[]) => (
    <Text>{`active: ${active.map((m) => m.id).join(',') || 'none'}`}</Text>
  );

  it('asks nothing and hands over none with an empty list (the registry today)', async () => {
    mockAll = { a: caps({ contributions: true }) };
    await render(<WithActiveModules>{ids}</WithActiveModules>);
    expect(screen.getByText('active: none')).toBeTruthy();
    await render(
      <WithActiveModules modules={[]} connectionId="a">
        {ids}
      </WithActiveModules>,
    );
    expect(screen.getByText('active: none')).toBeTruthy();
    expect(mockCapabilitiesAll).not.toHaveBeenCalled();
    expect(mockServerInfo).not.toHaveBeenCalled();
  });

  it("hands over the modules on across the servers, or on one connection's", async () => {
    mockAll = { a: caps({ contributions: false }), b: caps({ contributions: true }) };
    await render(<WithActiveModules modules={[CONTRIB]}>{ids}</WithActiveModules>);
    expect(screen.getByText('active: contributions')).toBeTruthy();
    await render(
      <WithActiveModules modules={[CONTRIB]} connectionId="a">
        {ids}
      </WithActiveModules>,
    );
    expect(screen.getByText('active: none')).toBeTruthy();
  });
});
