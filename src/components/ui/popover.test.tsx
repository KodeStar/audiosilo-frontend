import { fireEvent, screen } from '@testing-library/react-native';

import { mountWithPortal } from '@/testing/render-overlay';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Text } from './text';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

describe('Popover', () => {
  it('opens its content into the portal from the trigger', async () => {
    await mountWithPortal(
      <Popover>
        <PopoverTrigger accessibilityLabel="Details">
          <Text>Details</Text>
        </PopoverTrigger>
        <PopoverContent>
          <Text>Synced 2 min ago</Text>
        </PopoverContent>
      </Popover>,
    );
    expect(screen.queryByText('Synced 2 min ago')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Synced 2 min ago')).toBeTruthy();
  });
});

describe('DropdownMenu', () => {
  it('lists its items as menu items and reports the pick', async () => {
    const onPress = jest.fn();
    await mountWithPortal(
      <DropdownMenu>
        <DropdownMenuTrigger accessibilityLabel="More">
          <Text>More</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem icon="bookmark" onPress={onPress}>
            <Text>Add bookmark</Text>
          </DropdownMenuItem>
          <DropdownMenuItem icon="trash" variant="destructive">
            <Text>Remove</Text>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'More' }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    expect(String(screen.getByText('Remove').props.className)).toContain('text-destructive');
    await fireEvent.press(screen.getByRole('menuitem', { name: 'Add bookmark' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('Tooltip', () => {
  it('shows its ink label', async () => {
    await mountWithPortal(
      <Tooltip>
        <TooltipTrigger accessibilityLabel="Sleep timer">
          <Text>Zz</Text>
        </TooltipTrigger>
        <TooltipContent>
          <Text>Sleep timer</Text>
        </TooltipContent>
      </Tooltip>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Sleep timer' }));
    expect(String(screen.getByText('Sleep timer').props.className)).toContain(
      'text-primary-foreground',
    );
  });
});
