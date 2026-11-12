// Which of the account's addresses the watch uses now (the twin of
// targets/watch/Net/AddressRouter.swift): re-picked at launch, on coming to the foreground and
// every 90 s while in it. Home only after a tokenless probe answered this server's id
// (AddressPicker); else away; else the paired URL. A background worker picks for itself
// (`AddressPicker.pick` over its own network), so this is the foreground's pick only; a book's
// long run keeps its own pick proven with ProvenBookServer, below.
package app.audiosilo.wear.net

import app.audiosilo.wear.core.Account
import app.audiosilo.wear.core.AddressPicker
import app.audiosilo.wear.core.Book
import app.audiosilo.wear.core.BookRef
import app.audiosilo.wear.core.BookServer
import app.audiosilo.wear.core.ChaptersResponse
import app.audiosilo.wear.core.Fetched
import app.audiosilo.wear.core.ProgressRow
import app.audiosilo.wear.core.RenditionsAnswer
import app.audiosilo.wear.core.ServerIdProbe
import app.audiosilo.wear.core.secondsSince
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class AddressRouter(private val scope: CoroutineScope, private val probe: ServerIdProbe = { ApiClient.probeServerId(it) }) {
  private val pick = MutableStateFlow<String?>(null)

  /** The address in use (Sync and account shows it). */
  val current: StateFlow<String?> = pick.asStateFlow()

  private val generation = AtomicInteger()
  private var timer: Job? = null

  /**
   * The address for `account` now: the pick while it is still one of its own. With none (a launch,
   * before the probe), what a home that did not answer leaves: never a home address unproven
   * while another is known.
   */
  fun base(account: Account): String {
    val c = pick.value
    if (c != null && AddressPicker.isOwn(c, account.serverUrl, account.addresses)) return c
    return AddressPicker.unproven(account.serverUrl, account.addresses)
  }

  /** Start on the address the sign-in answered at (already proven: the exchange checked it). */
  fun start(at: String?) {
    generation.incrementAndGet()
    pick.value = at
  }

  suspend fun repick(account: Account) {
    val mine = generation.incrementAndGet()
    val url = AddressPicker.pick(account.serverUrl, account.addresses, account.serverId, probe)
    if (mine == generation.get()) pick.value = url
  }

  /** Ask home again every `HOME_RECHECK` while in the foreground (walking in the door raises no event). */
  fun startRechecks(account: () -> Account?) {
    timer?.cancel()
    timer =
      scope.launch {
        while (isActive) {
          delay((HOME_RECHECK * 1000).toLong())
          val a = account() ?: continue
          if (a.addresses?.home != null) repick(a)
        }
      }
  }

  fun stopRechecks() {
    timer?.cancel()
    timer = null
  }

  /**
   * Going to the background: the watch may join another network before it is back, where another
   * box can hold the same private address, so a home pick is dropped until the next probe proves
   * it again. A probe still in flight is dropped too, or its answer would land home after this.
   */
  fun leaveHome(account: Account) {
    generation.incrementAndGet()
    val c = pick.value ?: return
    val home = account.addresses?.home ?: return
    if (AddressPicker.sameURL(c, home)) pick.value = AddressPicker.fallback(account.serverUrl, account.addresses)
  }

  /** Signed out: no pick. */
  fun reset() {
    generation.incrementAndGet()
    pick.value = null
  }

  companion object {
    /** How often home is asked again in the foreground (seconds). */
    const val HOME_RECHECK = 90.0
  }
}

/**
 * A book run's server (BookWorker), at an address proven for now. The run's pick was proven on the
 * network its probe ran over, and a run can outlast that network: on the phone's connection the
 * watch leaves the house mid-book, where the same private address may be another box. So a home
 * pick `HOME_RECHECK` old is asked again with no token, as the foreground does, before the next
 * request carries the token; a home that no longer answers as this server gives way to the away
 * address for the rest of the run (never back: the next run picks afresh).
 */
class ProvenBookServer(
  private val account: Account,
  first: String,
  private val probe: ServerIdProbe,
  private val clock: () -> Instant = Instant::now,
  private val client: (String) -> BookServer,
) : BookServer {
  private var base = first
  private var server = client(first)
  private var provenAt = clock()

  private suspend fun proven(): BookServer {
    val home = account.addresses?.home ?: return server
    if (!AddressPicker.sameURL(base, home)) return server
    val age = clock().secondsSince(provenAt)
    // A clock set back is no proof either.
    if (age >= 0 && age < AddressRouter.HOME_RECHECK) return server
    val next = AddressPicker.pick(account.serverUrl, account.addresses, account.serverId, probe)
    provenAt = clock()
    if (!AddressPicker.sameURL(next, base)) {
      base = next
      server = client(next)
    }
    return server
  }

  override suspend fun item(ref: BookRef): Book = proven().item(ref)

  override suspend fun chapters(ref: BookRef): ChaptersResponse = proven().chapters(ref)

  override suspend fun progress(ref: BookRef): ProgressRow? = proven().progress(ref)

  override suspend fun prepareRenditions(ref: BookRef): RenditionsAnswer = proven().prepareRenditions(ref)

  override suspend fun renditionStatus(ref: BookRef): RenditionsAnswer = proven().renditionStatus(ref)

  override suspend fun download(libraryId: Int, file: String, from: Long, ifRange: String?): Fetched =
    proven().download(libraryId, file, from, ifRange)
}
