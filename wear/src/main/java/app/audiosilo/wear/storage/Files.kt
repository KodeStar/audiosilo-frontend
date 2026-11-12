// Where the Wear app keeps everything (the twin of targets/watch/Storage/Files.swift). Under
// filesDir, which Android never backs up here (data_extraction_rules.xml excludes every domain):
//
//   account.json        the signed-in account (no token: TokenStore)
//   server.json         the server's last /server answer (the gate, offline)
//   acks.json           acknowledged versions + answered offers (AckStore)
//   outbox.json         events waiting (Outbox)
//   sync-state.json     last sync, couldn't-sync list, clock skew (Outbox)
//   outbox-unread-*.json an outbox that could not be read, kept aside (Outbox)
//   open-span.json      the span being played (SpanRecorder, W4a pass 2)
//   places.json         this watch's own place per book (PlaceStore, W4a pass 2)
//   continue.json       Continue listening's last rows (ContinueListening)
//   downloads.json      the books on this watch (DownloadIndex)
//   held-books.json     books from the phone not taken yet, or given up on (HeldBooks)
//   items/              each book's item + chapters, kept for offline playback
//   books/<folder>/     each book's rendition files (BookDownload)
//
// And under noBackupFilesDir (decision 11): session.bin (the token, sealed by the Keystore key)
// and device-id (this watch's device_id, a UUID made once).
package app.audiosilo.wear.storage

import android.content.Context
import app.audiosilo.wear.core.BookRef
import app.audiosilo.wear.core.BookStorage
import app.audiosilo.wear.core.DownloadRecord
import app.audiosilo.wear.core.ItemCache
import app.audiosilo.wear.core.JsonFile
import java.io.File

class Files(val root: File, val noBackup: File) : BookStorage {
  constructor(context: Context) : this(context.filesDir, context.noBackupFilesDir)

  val account: File get() = File(root, "account.json")
  val server: File get() = File(root, "server.json")
  val acks: File get() = File(root, "acks.json")
  val openSpan: File get() = File(root, "open-span.json")
  val places: File get() = File(root, "places.json")
  val continueRows: File get() = File(root, "continue.json")
  val downloadsIndex: File get() = File(root, "downloads.json")
  val heldBooks: File get() = File(root, "held-books.json")
  val items: File get() = File(root, "items")
  val books: File get() = File(root, "books")

  /** The sealed session token. */
  val session: File get() = File(noBackup, "session.bin")
  val deviceIdFile: File get() = File(noBackup, "device-id")

  /** A book's item cache file. */
  fun item(ref: BookRef): File = File(items, safeName(ref.key) + ".json")

  override fun folder(record: DownloadRecord): File = File(books, record.folder)

  override fun saveItem(ref: BookRef, cache: ItemCache) {
    items.mkdirs()
    JsonFile(item(ref), ItemCache.serializer()).write(cache)
  }

  override fun loadItem(ref: BookRef): ItemCache? = JsonFile(item(ref), ItemCache.serializer()).read()

  /** Free space for the books (StatFs's available bytes), null when unknown. */
  override fun freeBytes(): Long? = root.usableSpace.takeIf { it > 0 }

  companion object {
    /** A file name for any string: its letters and digits (the last 60), plus an FNV-1a hash. */
    fun safeName(s: String): String {
      var h = -0x340d631b7bdddcdbL // 14695981039346656037, FNV-1a's offset basis
      for (b in s.toByteArray(Charsets.UTF_8)) {
        h = (h xor (b.toLong() and 0xff)) * 0x100000001b3L
      }
      val readable = s.map { if (it.isLetterOrDigit()) it else '_' }.joinToString("")
      return readable.takeLast(60) + "-" + java.lang.Long.toUnsignedString(h, 16)
    }
  }
}
