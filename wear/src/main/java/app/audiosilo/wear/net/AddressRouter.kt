// Which of the account's addresses the watch uses now (the twin of
// targets/watch/Net/AddressRouter.swift): re-picked at launch, on coming to the foreground and
// every 90 s while in it. Home only after a tokenless probe answered this server's id
// (AddressPicker); else away; else the paired URL. A background worker picks for itself
// (`AddressPicker.pick` over its own network), so this is the foreground's pick only.
package app.audiosilo.wear.net

import app.audiosilo.wear.core.Account
import app.audiosilo.wear.core.AddressPicker
import app.audiosilo.wear.core.ServerIdProbe
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
