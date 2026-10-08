import { Icon } from '@/components/ui/icon';

/** The back chevron of the sub-nav and the phone header. */
export function BackGlyph({ size, color }: { size: number; color: string }) {
  return <Icon name="chevron-left" size={size} color={color} />;
}
