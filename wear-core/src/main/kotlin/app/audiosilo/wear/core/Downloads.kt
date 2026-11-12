// The books on this watch and what the watch keeps of each, the Kotlin side of
// targets/watch/Net/DownloadManager.swift's records (On this watch): the account, a book's item
// and chapters for offline playback, Continue listening's rows, and the downloads index. Pure, so
// the rules test on the JVM; wear's BookWorker and AppModel drive them.
package app.audiosilo.wear.core

import java.io.File
import java.time.Instant
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

/** The one account this watch is signed in to (decision 3). The token is never here. */
@Serializable
data class Account(
  val serverId: String,
  /** The phone's server label, including its address when saved server names collide. */
  val serverName: String,
  val userId: Int,
  val userName: String,
  /** The paired URL (the phone connection's). */
  val serverUrl: String,
  val addresses: ServerAddresses? = null,
  val signedInAt: StoredInstant,
) {
  /** `<server_id>.<user_id>`, the phone's connection id for the same account. */
  val accountId: String
    get() = accountIdOf(serverId, userId)
}

/** A book's item and chapters, kept for offline playback (items/). */
@Serializable
data class ItemCache(
  val book: Book,
  val chapters: ChaptersResponse? = null,
  /**
   * The server's place when the download started (the phone's keepServerPlace): what an offline
   * first play opens at when Continue listening does not list the book.
   */
  val serverPlace: ProgressRow? = null,
) {
  val timeline: Timeline
    get() = Timeline.of(book, chapters)
}

@Serializable
data class DownloadedFile(
  /** The original file's rel path (the rendition's `path`). */
  val path: String,
  /** Its file name in the book's folder. */
  val local: String,
  val bytes: Long? = null,
  val done: Boolean = false,
)

@Serializable
data class DownloadRecord(
  val ref: BookRef,
  val title: String,
  val author: String? = null,
  /** The book's folder under books/ (a fresh name per download, so a removed book leaves nothing behind). */
  val folder: String,
  val state: WatchStateBook.State,
  /** In play order (the timeline's), filled once the item is read. */
  val files: List<DownloadedFile> = emptyList(),
  /** Why it failed, or what it waits for. */
  val message: String? = null,
  val addedAt: StoredInstant,
  /** The phone's `sent_at` when the phone queued it: a `remove` older than this is ignored. */
  val sentAt: StoredInstant? = null,
  /** Q3: no unmetered Wi-Fi came within 30 s, so the row offers the phone's connection. */
  val waitingForWifi: Boolean = false,
  /** The listener chose the phone's connection (slow) for this book. */
  val slow: Boolean = false,
) {
  val key: String
    get() = ref.key

  val doneCount: Int
    get() = files.count { it.done }

  /** The bytes on the watch (each file's size, set when it lands). */
  val bytes: Long
    get() = files.mapNotNull { it.bytes }.sum()

  /** When it was queued, for `PhoneMessages.removeApplies`. */
  val queuedAt: Instant
    get() = sentAt ?: addedAt
}

/** One row of Continue listening: a book started and not finished, with its title. */
@Serializable
data class ContinueRow(
  val ref: BookRef,
  val title: String,
  val author: String? = null,
  val position: Double,
  val duration: Double,
  val updatedAt: String,
  /** The row's version and the device that wrote it, so the kept place follows Resume.plan's rule. */
  val version: Int? = null,
  val deviceId: String? = null,
  /** The book's own speed, for the same offline first play. */
  val playbackSpeed: Double? = null,
) {
  val fraction: Double
    get() = if (duration > 0) minOf(1.0, position / duration) else 0.0

  /** The server's place as the last refresh read it (ContinueListening.keptPlace). */
  fun keptPlace(): ProgressRow =
    ProgressRow(
      libraryId = ref.libraryId,
      path = ref.path,
      position = position,
      duration = duration,
      finished = false,
      playbackSpeed = playbackSpeed,
      version = version ?: 0,
      deviceId = deviceId,
      updatedAt = updatedAt,
    )
}

object ContinueRows {
  /** How many books Continue listening lists, and so the most `/item` reads one refresh makes. */
  const val LIMIT = 10

  /**
   * The rows for `/me/progress`'s answer: the books in progress, newest first, at most `LIMIT`,
   * each titled from its kept item, else one read now (`fetch`, kept by the caller), else its
   * file name. `stillWanted` false stops early (an account since signed out, or a newer refresh).
   */
  suspend fun build(
    all: List<ProgressRow>,
    cached: (BookRef) -> Book?,
    fetch: suspend (BookRef) -> Book?,
    stillWanted: () -> Boolean = { true },
  ): List<ContinueRow>? {
    val rows = ArrayList<ContinueRow>()
    for (p in ContinueOrder.inProgress(all, LIMIT)) {
      if (!stillWanted()) return null
      val book = cached(p.ref) ?: fetch(p.ref)
      rows +=
        ContinueRow(
          ref = p.ref,
          title = book?.title?.takeIf { it.isNotBlank() } ?: p.path.substringAfterLast('/'),
          author = book?.author,
          position = p.position,
          duration = if (p.duration > 0) p.duration else book?.duration ?: 0.0,
          updatedAt = p.updatedAt,
          version = p.version,
          deviceId = p.deviceId,
          playbackSpeed = p.playbackSpeed,
        )
    }
    return if (stillWanted()) rows else null
  }
}

/**
 * The books on this watch (downloads.json), one record per book of the signed-in account. Thread
 * safe: the UI, the phone's messages and each book's worker all change it. `records` is the list
 * the screens watch.
 */
class DownloadIndex(file: File?, private val newFolder: () -> String = { java.util.UUID.randomUUID().toString() }) {
  private val file = file?.let { JsonFile(it, ListSerializer(DownloadRecord.serializer())) }
  private val lock = Any()
  private val flow = MutableStateFlow(this.file?.read() ?: emptyList())

  val records: StateFlow<List<DownloadRecord>> = flow.asStateFlow()

  /** False when the last write failed (a full disk): `records` would not survive a kill. */
  @Volatile
  var saved: Boolean = true
    private set

  fun record(ref: BookRef): DownloadRecord? = flow.value.firstOrNull { it.ref == ref }

  /**
   * Queue a book (the Download button, the phone's `book`). A failed one is tried again; one already
   * here or on its way is left alone. True when there is work to start.
   */
  fun enqueue(ref: BookRef, title: String, author: String?, now: Instant, sentAt: Instant? = null): Boolean =
    synchronized(lock) {
      val r = record(ref)
      if (r != null) {
        if (r.state != WatchStateBook.State.FAILED) return false
        commit(flow.value.map { if (it.ref == ref) it.copy(state = WatchStateBook.State.QUEUED, message = null, sentAt = sentAt ?: it.sentAt) else it })
      } else {
        val rec =
          DownloadRecord(
            ref = ref,
            title = title,
            author = author,
            folder = newFolder(),
            state = WatchStateBook.State.QUEUED,
            addedAt = now,
            sentAt = sentAt,
          )
        commit(flow.value + rec)
      }
      true
    }

  /** Change one record; nothing when it is gone (removed meanwhile). Returns the new record. */
  fun update(ref: BookRef, change: (DownloadRecord) -> DownloadRecord): DownloadRecord? =
    synchronized(lock) {
      val r = record(ref) ?: return null
      val next = change(r)
      if (next != r) commit(flow.value.map { if (it.ref == ref) next else it })
      next
    }

  /** Forget a book's record (its files are the caller's). Returns the record it was. */
  fun remove(ref: BookRef): DownloadRecord? =
    synchronized(lock) {
      val r = record(ref) ?: return null
      commit(flow.value.filter { it.ref != ref })
      r
    }

  /** Forget every record (the account was left). Returns what they were. */
  fun removeAll(): List<DownloadRecord> =
    synchronized(lock) {
      val all = flow.value
      commit(emptyList())
      all
    }

  private fun commit(next: List<DownloadRecord>) {
    flow.value = next
    saved = file?.write(next.ifEmpty { null }) ?: true
  }
}
