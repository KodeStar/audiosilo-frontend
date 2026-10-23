import { FindShowsScreen } from '@/components/podcasts/find-shows-screen';

// /find-shows?connection=<cid>&library=<id>[&section=search|address|import] (findShowsHref):
// adding shows to a podcast library (Bridge Phase 2d-2), pushed from its Shows mode. The
// Library tab's own page, not the array group's: only the Library opens it, and a cold
// link (a reload, a pasted URL) must land in the Library tab, not in Home (the first tab
// group, which owns a cold link to a shared page).
export default FindShowsScreen;
