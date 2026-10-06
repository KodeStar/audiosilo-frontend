import { PersonScreen } from '@/components/library/person-screen';

// /narrator?connection=<cid>&library=<id>&name=<narrator> (narratorHref)
export default function NarratorScreen() {
  return <PersonScreen kind="narrator" />;
}
