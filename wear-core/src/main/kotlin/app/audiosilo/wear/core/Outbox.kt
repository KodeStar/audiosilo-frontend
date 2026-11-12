// The watch's listening outbox (Sync v2), a port of targets/watch/Core/Outbox.swift (itself the
// sending half of the phone's `src/playback/listening-outbox.ts`; CROSS-REPO section 25). One
// account per watch, so one outbox: events wait here, append-only and immutable, until the server
// answers for them (`POST /me/listening/sync`).
//
// Sending (`flush`): one request in flight, chunks of 200, `sent_at` set per attempt (the body is
// built as it is sent, also by the background SyncWorker: W4 decision 9). Every status but
// `rejected` removes the event; `rejected` moves it to the couldn't-sync list (30 days, at most
// 100). No answer (offline), 401, 403, 404/405 and 5xx keep everything (no PUT fallback: the server
// gate up front). A 413 or `too_many_events` halves the chunk, and one event alone still 413 is
// listed `too_large`; a 400 on a batch sends its events one by one once, and one refused alone is
// listed `invalid`. Before sending, an event older than 89 days is listed `too_old` unsent.
//
// `lastFlushFailed` says the last ANSWER: true from a failed attempt until the server next answers,
// also while a retry is in flight (it is what the 15 s cut reads, so offline the span stays open).
// A file that exists but can't be read is moved aside, never overwritten (`restoredEvents`).
//
// Thread-safe: the app's main thread and the SyncWorker may both call it; one flush runs at a time.
package app.audiosilo.wear.core

import java.io.File
import java.time.Instant
import java.util.UUID
import kotlin.math.max
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

/** An event the server would not take, kept to show (the couldn't-sync list). */
@Serializable
data class CouldNotSync(val event: ListeningEvent, val reason: String, val at: StoredInstant)

/** What Sync status shows, and the server's clock skew. */
@Serializable
data class SyncState(
  val lastSyncAt: StoredInstant? = null,
  val failed: List<CouldNotSync> = emptyList(),
  /** How far ahead of the watch's clock the server's was at the last answer (ms). */
  val clockSkewMs: Double? = null,
)

/**
 * Sends one batch: the ApiClient in the app, a fake in the tests. Throws `APIError` for a server's
 * own answer, anything else for no answer.
 */
fun interface ListeningSyncTransport {
  suspend fun syncListening(request: SyncRequest): SyncResponse
}

class Outbox(
  private val directory: File?,
  private val acks: AckStore,
  private val deviceId: String,
  private val clock: () -> Instant = Instant::now,
) {
  private val lock = Any()
  private val eventsFile = directory?.let { JsonFile(File(it, "outbox.json"), EVENTS, durable = true) }
  private val stateFile = directory?.let { JsonFile(File(it, "sync-state.json"), SyncState.serializer()) }

  /** What waits, oldest first. */
  var events: List<ListeningEvent> = eventsFile?.let(::restoredEvents) ?: emptyList()
    get() = synchronized(lock) { field }
    private set

  var state: SyncState = stateFile?.read() ?: SyncState()
    get() = synchronized(lock) { field }
    private set

  /** The server has not answered since a flush failed (offline, or the server failed). */
  @Volatile
  var lastFlushFailed = false
    private set

  private var chunkSize = MAX_CHUNK
  private var running: CompletableDeferred<Unit>? = null
  private var again = false

  /** The transport the newest `flush` call brought: each chunk goes through it. */
  private var transport: ListeningSyncTransport? = null

  /**
   * Bumped by `discardAll`: an answer or a failure of a request sent before it says nothing about
   * what waits now, and ends that flush.
   */
  private var discards = 0

  /** Told of every answer's progress rows (the offer check). */
  @Volatile var onAnswer: ((List<ProgressRow>) -> Unit)? = null

  /** Told whenever the events or the state change (watch-state, Sync status). */
  @Volatile var onChange: (() -> Unit)? = null

  // The document

  /**
   * What waited at the last launch. A file that exists but can't be read (damaged, or another
   * build's format) is moved aside, so the next save never writes over that listening, and joins
   * what waits at a later launch if it reads by then.
   */
  private fun restoredEvents(main: JsonFile<List<ListeningEvent>>): List<ListeningEvent> {
    val directory = checkNotNull(main.file.parentFile)
    val current = main.read()
    if (current == null && main.file.exists()) {
      main.file.renameTo(File(directory, ASIDE_PREFIX + UUID.randomUUID() + ".json"))
    }
    val have = (current ?: emptyList()).map { it.id }.toMutableSet()
    val older = ArrayList<ListeningEvent>()
    val joined = ArrayList<File>()
    for (file in asideFiles(directory)) {
      val more = JsonFile(file, EVENTS).read() ?: continue
      older += more.filter { have.add(it.id) }
      joined += file
    }
    val events = older + (current ?: emptyList())
    if (joined.isEmpty()) return events
    save(main, events)
    // Gone only once they are safely in the outbox (a full disk: tried again next launch).
    if ((main.read() ?: emptyList()).size == events.size) joined.forEach { it.delete() }
    return events
  }

  /**
   * Append closed events (immutable from here); one with a number that is not one, or an id already
   * waiting, is dropped.
   */
  fun append(given: List<ListeningEvent>) {
    synchronized(lock) {
      val have = events.map { it.id }.toMutableSet()
      val add = given.filter { it.isFinite && have.add(it.id) }
      if (add.isEmpty()) return
      events = events + add
      eventsFile?.let { save(it, events) }
    }
    onChange?.invoke()
  }

  /** Every event waiting (signing out is blocked while any is). */
  val unsentCount: Int
    get() = events.size

  /** The couldn't-sync list, entries past 30 days left out. */
  fun couldNotSync(now: Instant? = null): List<CouldNotSync> {
    val t = now ?: clock()
    return state.failed.filter { stillKept(it, t) }
  }

  /** Take one event off the couldn't-sync list. */
  fun discardFailed(id: String) {
    synchronized(lock) {
      state = state.copy(failed = state.failed.filter { it.event.id != id })
      stateFile?.write(state)
    }
    onChange?.invoke()
  }

  /** Drop everything (the listener chose to discard what waits, then signed out). */
  fun discardAll() {
    synchronized(lock) {
      discards += 1
      transport = null
      again = false
      events = emptyList()
      state = SyncState()
      chunkSize = MAX_CHUNK
      // Nothing waits, so nothing failed: the 15 s cut runs again (the cold-start state).
      lastFlushFailed = false
      // Never joined to another account's outbox at a later launch.
      directory?.let { d -> asideFiles(d).forEach { it.delete() } }
      eventsFile?.let { save(it, events) }
      stateFile?.write(state)
    }
    onChange?.invoke()
  }

  private fun moveToFailed(items: List<Pair<ListeningEvent, String>>) {
    if (items.isEmpty()) return
    synchronized(lock) {
      val now = clock()
      val ids = items.map { it.first.id }.toSet()
      val kept = state.failed.filter { stillKept(it, now) && it.event.id !in ids }
      val failed = (kept + items.map { CouldNotSync(it.first, it.second, now) }).takeLast(MAX_COULD_NOT_SYNC)
      state = state.copy(failed = failed)
      stateFile?.write(state)
      removeLocked(ids)
    }
    onChange?.invoke()
  }

  private fun removeLocked(ids: Set<String>) {
    if (ids.isEmpty()) return
    val before = events.size
    events = events.filter { it.id !in ids }
    if (events.size != before) eventsFile?.let { save(it, events) }
  }

  /**
   * Events older than `GIVE_UP_AGE` go to the list unsent (`too_old`): the server refuses one past
   * 90 days, so it could only wait.
   */
  fun giveUpOld() {
    val now = clock()
    val old = events.filter { e -> e.time?.let { now.secondsSince(it) > GIVE_UP_AGE } ?: false }
    moveToFailed(old.map { it to "too_old" })
  }

  // Sending

  /**
   * Send what waits. One flush at a time: a call while one runs makes it go round once more, through
   * the transport that call brought (the address or the token may have changed).
   */
  suspend fun flush(via: ListeningSyncTransport) {
    val mine = CompletableDeferred<Unit>()
    val wait: CompletableDeferred<Unit>?
    synchronized(lock) {
      transport = via
      wait = running
      if (wait != null) again = true else running = mine
    }
    if (wait != null) {
      wait.await()
      return
    }
    try {
      while (true) {
        synchronized(lock) { again = false }
        flushOnce()
        // In the same step that reads `again`: a call can't slip in between and be lost.
        val done = synchronized(lock) {
          if (again) {
            false
          } else {
            running = null
            transport = null
            true
          }
        }
        if (done) break
      }
    } finally {
      synchronized(lock) {
        if (running === mine) {
          running = null
          transport = null
        }
      }
      mine.complete(Unit)
    }
  }

  private enum class Next {
    MORE,
    STOP,
  }

  private suspend fun flushOnce() {
    giveUpOld()
    repeat(MAX_ROUNDS) {
      val (chunk, via) =
        synchronized(lock) {
          if (events.isEmpty()) {
            // Nothing waits, so nothing failed.
            lastFlushFailed = false
            return
          }
          val t = transport ?: return
          events.take(chunkSize) to t
        }
      if (sendChunk(chunk, via) == Next.STOP) return
    }
  }

  private fun body(events: List<ListeningEvent>) =
    SyncRequest(deviceId = deviceId, sentAt = ISOTime.string(clock()), events = events)

  private fun discardsNow(): Int = synchronized(lock) { discards }

  private suspend fun sendChunk(chunk: List<ListeningEvent>, transport: ListeningSyncTransport): Next {
    val sentBefore = discardsNow()
    try {
      val sentAt = clock()
      val answer = transport.syncListening(body(chunk))
      if (sentBefore != discardsNow()) return Next.STOP
      apply(answer, chunk, sentAt, clock())
      return Next.MORE
    } catch (e: APIError) {
      if (sentBefore != discardsNow()) return Next.STOP
      if (e.status == 413 || e.code == "too_many_events") {
        if (chunk.size > 1) {
          synchronized(lock) { chunkSize = max(1, chunk.size / 2) }
          return Next.MORE
        }
        moveToFailed(listOf(chunk[0] to "too_large"))
        return Next.MORE
      }
      if (e.status == 400) return sendOneByOne(chunk, transport)
      // 401, 403, 404/405, 5xx: keep them for a later try.
      lastFlushFailed = true
      return Next.STOP
    } catch (e: kotlinx.coroutines.CancellationException) {
      throw e
    } catch (_: Exception) {
      if (sentBefore != discardsNow()) return Next.STOP
      lastFlushFailed = true
      return Next.STOP
    }
  }

  private suspend fun sendOneByOne(chunk: List<ListeningEvent>, transport: ListeningSyncTransport): Next {
    if (chunk.size == 1) {
      moveToFailed(listOf(chunk[0] to "invalid"))
      return Next.MORE
    }
    val sentBefore = discardsNow()
    for (event in chunk) {
      try {
        val answer = transport.syncListening(body(listOf(event)))
        if (sentBefore != discardsNow()) return Next.STOP
        apply(answer, listOf(event), null, null)
      } catch (e: APIError) {
        if (sentBefore != discardsNow()) return Next.STOP
        if (e.status != 400) {
          lastFlushFailed = true
          return Next.STOP
        }
        moveToFailed(listOf(event to "invalid"))
      } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
      } catch (_: Exception) {
        if (sentBefore != discardsNow()) return Next.STOP
        lastFlushFailed = true
        return Next.STOP
      }
    }
    return Next.MORE
  }

  /**
   * Apply a sync answer for the events `sent`: each answered one leaves (rejected to the list), the
   * skew is measured when the request's times are known, and a row that kept this device's event
   * has its version acknowledged.
   */
  fun apply(answer: SyncResponse, sent: List<ListeningEvent>, sentAt: Instant?, answeredAt: Instant?) {
    // The server answered: reachable, so the 15 s cuts run again.
    lastFlushFailed = false
    val results = LinkedHashMap<String, SyncResult>()
    for (r in answer.results ?: emptyList()) results.putIfAbsent(r.id, r)
    val done = HashSet<String>()
    val rejected = ArrayList<Pair<ListeningEvent, String>>()
    for (event in sent) {
      val r = results[event.id] ?: continue // no result: try again later
      if (r.status == "rejected") rejected += event to (r.reason ?: "invalid") else done += event.id
    }
    synchronized(lock) { removeLocked(done) }
    moveToFailed(rejected)
    synchronized(lock) {
      val skew =
        if (sentAt != null && answeredAt != null) ClockSkew.of(answer.serverTime, sentAt, answeredAt) else null
      state = state.copy(lastSyncAt = clock(), clockSkewMs = skew ?: state.clockSkewMs)
      stateFile?.write(state)
    }
    onChange?.invoke()
    val rows = answer.progress ?: emptyList()
    for (row in rows) {
      if (AckRules.keptMine(row, deviceId, sent, results)) acks.ack(row.ref, row.version)
    }
    onAnswer?.invoke(rows)
  }

  companion object {
    const val MAX_CHUNK = 200
    const val COULD_NOT_SYNC_KEEP: Double = 30.0 * 24 * 3600
    const val MAX_COULD_NOT_SYNC = 100
    const val GIVE_UP_AGE: Double = 89.0 * 24 * 3600

    /** How many rounds one flush makes at most. */
    const val MAX_ROUNDS = 50

    private const val ASIDE_PREFIX = "outbox-unread-"
    private val EVENTS = ListSerializer(ListeningEvent.serializer())

    /**
     * Store what waits: nothing waiting removes the file (one folder sync, not a synced `[]`); a
     * missing file reads as an empty outbox at launch.
     */
    private fun save(file: JsonFile<List<ListeningEvent>>, events: List<ListeningEvent>) {
      file.write(events.ifEmpty { null })
    }

    private fun asideFiles(directory: File): List<File> =
      directory.listFiles { f -> f.name.startsWith(ASIDE_PREFIX) }?.toList() ?: emptyList()

    /** Whether a couldn't-sync entry is still kept (30 days). */
    private fun stillKept(f: CouldNotSync, now: Instant): Boolean = now.secondsSince(f.at) < COULD_NOT_SYNC_KEEP
  }
}
