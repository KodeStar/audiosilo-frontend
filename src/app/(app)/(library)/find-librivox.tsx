import { FindLibrivoxScreen } from '@/components/librivox/find-librivox-screen';

// /find-librivox?connection=<cid>&library=<id> (findLibrivoxHref): finding a LibriVox
// recording to add to a books library (LibriVox L6, admin only), pushed from the Books
// mode's menu. The Library tab's own page, like Find shows: only the Library opens it, and
// a cold link (a reload, a pasted URL) lands in the Library tab.
export default FindLibrivoxScreen;
