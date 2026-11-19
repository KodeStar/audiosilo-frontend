// The acknowledged version per book (`base_version`) and the offer of another device's place, a
// port of targets/watch/Core/AckAndOffer.swift (itself `progress-sync.ts` (`ackVersion`,
// `answerOffer`), `listening-outbox.ts` (`keptMine`) and `place-reconcile.ts` (`offerOf`,
// `OFFER_REPEAT_MS`)). CROSS-REPO section 25: every span carries `base_version`, the version this
// device acknowledged when it closed (0 on a cold start), so an old offline span never moves a
// further place back.
package app.audiosilo.wear.core

import java.io.File
import java.time.Instant
import kotlin.math.abs
import kotlin.math.max
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

/** What the watch keeps per book: the acknowledged version and the offers answered. */
@Serializable
data class BookAck(
  val ackVersion: Int? = null,
  /** `device_id|updated_at` keys of the offers answered (the newest `MAX_ANSWERED`). */
  val answered: List<String> = emptyList(),
)

/**
 * The acknowledged versions, kept in a file (`acks.json`). Thread-safe. Given the listening's
 * `DurableWriter` (Wear, fe#285), the file is written there, in the order asked with the outbox
 * and the places. An offer's Jump is acknowledged in memory before its move (the move's events go
 * on the row's version) and written after it (`answerOffer(save = false)`, then `save`): the
 * acknowledgement on the disk without the move would resume at the old place on the other device's
 * version after a kill, sending that place back.
 */
class AckStore(file: File?, writer: DurableWriter? = null) {
  private val file = file?.let { JsonFile(it, SERIALIZER, writer = writer) }
  private var books: Map<String, BookAck> = this.file?.read() ?: emptyMap()

  @Synchronized fun ackVersion(ref: BookRef): Int? = books[ref.key]?.ackVersion

  @Synchronized fun answered(ref: BookRef): List<String> = books[ref.key]?.answered ?: emptyList()

  /** Acknowledge `version` of a book's row; never lowers a known acknowledgement. */
  @Synchronized
  fun ack(ref: BookRef, version: Int) {
    val b = books[ref.key] ?: BookAck()
    val known = b.ackVersion
    if (known != null && known >= version) return
    put(ref, b.copy(ackVersion = version))
  }

  /**
   * An offer answered (Jump or Stay): the row's version acknowledged (never lowered) and the
   * offer's key noted, the newest `MAX_ANSWERED` kept. `save` false keeps it in memory only until
   * `save` (a Jump, whose move is written first).
   */
  @Synchronized
  fun answerOffer(ref: BookRef, row: ProgressRow, key: String, save: Boolean = true) {
    val b = books[ref.key] ?: BookAck()
    put(
      ref,
      BookAck(
        ackVersion = max(b.ackVersion ?: row.version, row.version),
        answered = (b.answered.filter { it != key } + key).takeLast(MAX_ANSWERED),
      ),
      save,
    )
  }

  /** Write what `answerOffer(save = false)` kept in memory. */
  @Synchronized
  fun save() {
    file?.write(books)
  }

  /**
   * An offer closed with neither Jump nor Stay: its key is noted so it is not offered again, and
   * nothing is acknowledged, so this watch's next spans still never move the other device's place
   * back (the phone's `ignoreOffer`, fe#208).
   */
  @Synchronized
  fun ignoreOffer(ref: BookRef, key: String) {
    val b = books[ref.key] ?: BookAck()
    if (b.answered.contains(key)) return
    put(ref, b.copy(answered = (b.answered + key).takeLast(MAX_ANSWERED)))
  }

  /**
   * Resuming from a server row (pull before play): a version above 0 is acknowledged, so the first
   * span goes on what this device saw. Auto-moving to another device's place is the same.
   */
  fun ackResume(row: ProgressRow) {
    if (row.version > 0) ack(row.ref, row.version)
  }

  /** Forget every book (signing out). */
  @Synchronized
  fun clear() {
    books = emptyMap()
    file?.write(null)
  }

  private fun put(ref: BookRef, ack: BookAck, save: Boolean = true) {
    books = books + (ref.key to ack)
    if (save) file?.write(books)
  }

  companion object {
    const val MAX_ANSWERED = 20
    private val SERIALIZER = MapSerializer(String.serializer(), BookAck.serializer())
  }
}

object AckRules {
  /**
   * Whether the server kept this device's event for the row's book in this answer (applied, or
   * diverged with the event kept): the rule for acknowledging the row's version.
   */
  fun keptMine(
    row: ProgressRow,
    deviceId: String,
    sent: List<ListeningEvent>,
    results: Map<String, SyncResult>,
  ): Boolean {
    if (row.deviceId != deviceId) return false
    return sent.any { e ->
      val r = results[e.id]
      e.ref == row.ref && r != null && (r.status == "applied" || (r.status == "diverged" && r.kept == "event"))
    }
  }

  /**
   * The books whose `stay` this answer held: the server kept the stored row over it (`diverged`,
   * `kept: stored`), another device's Stay holding it (CROSS-REPO section 25 "Stay wins", S2). Their
   * kept place is offered again at once (`OfferThrottle.shouldShow`'s `stayHeld`; the phone's
   * `staysHeld`).
   */
  fun staysHeld(sent: List<ListeningEvent>, results: Map<String, SyncResult>): Set<BookRef> =
    sent
      .filter { e ->
        val r = results[e.id]
        e is SpanEvent && e.start == ListeningStart.STAY && r != null && r.status == "diverged" &&
          r.kept == "stored"
      }
      .map { it.ref }
      .toSet()
}

/** Another device's place to offer (never to move to by itself). */
data class PlaceOffer(
  val position: Double,
  /** "" when the server doesn't know the device's name. */
  val deviceName: String,
  /** `device_id|updated_at` of the offered place. */
  val key: String,
)

object Offers {
  /** A smaller difference is not worth offering. */
  const val MOVE_THRESHOLD: Double = 30.0

  /** A device's places are offered at most once in this long per book. */
  const val OFFER_REPEAT: Double = 10.0 * 60

  /**
   * The offer for a row, or null: (a) the kept row when another device wrote it above this device's
   * ack version; else (b) the row's `other_place` when another device's; either only when more than
   * 30 s from here and not answered yet.
   */
  fun offerOf(
    row: ProgressRow?,
    deviceId: String,
    ackVersion: Int?,
    enginePosition: Double,
    answered: List<String> = emptyList(),
  ): PlaceOffer? {
    if (row == null) return null
    fun candidate(position: Double, device: String?, name: String?, updatedAt: String): PlaceOffer? {
      if (device.isNullOrEmpty() || device == deviceId) return null
      if (abs(position - enginePosition) <= MOVE_THRESHOLD) return null
      val key = "$device|$updatedAt"
      return if (answered.contains(key)) null else PlaceOffer(position, name ?: "", key)
    }
    val kept =
      if (!row.finished && row.version > (ackVersion ?: 0)) {
        candidate(row.position, row.deviceId, row.deviceName, row.updatedAt)
      } else {
        null
      }
    if (kept != null) return kept
    val other = row.otherPlace ?: return null
    return candidate(other.position, other.deviceId, other.deviceName, other.updatedAt)
  }
}

/**
 * Each offer once per launch, each device at most once per book in `OFFER_REPEAT`, except right
 * after this watch's Stay came back held (`stayHeld`).
 */
class OfferThrottle {
  private val shown = HashSet<String>()
  private val offeredAt = HashMap<String, Instant>()

  /**
   * Whether to show `offer` for `ref` now; records it when so. `stayHeld`: this watch's Stay came
   * back held by another device's (`AckRules.staysHeld`), so the place kept is offered now, not
   * `OFFER_REPEAT` after that device's last offer (still once per launch).
   */
  @Synchronized
  fun shouldShow(offer: PlaceOffer, ref: BookRef, now: Instant, stayHeld: Boolean = false): Boolean {
    val shownKey = "${ref.key}|${offer.key}"
    if (shown.contains(shownKey)) return false
    val bar = offer.key.lastIndexOf('|')
    val device = if (bar >= 0) offer.key.substring(0, bar) else offer.key
    val deviceKey = "${ref.key}|$device"
    val last = offeredAt[deviceKey]
    if (!stayHeld && last != null && now.secondsSince(last) < Offers.OFFER_REPEAT) return false
    shown.add(shownKey)
    offeredAt[deviceKey] = now
    return true
  }
}
