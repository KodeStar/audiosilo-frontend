import { PersonScreen } from '@/components/library/person-screen';

// /author?connection=<cid>&library=<id>&name=<author> (authorHref)
export default function AuthorScreen() {
  return <PersonScreen kind="author" />;
}
