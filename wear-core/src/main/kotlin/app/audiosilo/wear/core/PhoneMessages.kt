// The phone-watch message contract, a port of targets/watch/Core/PhoneMessages.swift (W3 plan, "The
// phone-watch message contract") carried over the Wear Data Layer (W4 plan, "The Data Layer
// contract"): the watch receives `pair`, `book` and `remove` from the phone and sends
// `watch-state`. Every message carries `v: 1`; an unknown type or a newer version is ignored. Each
// is a DataItem whose bytes are UTF-8 JSON (not a DataMap).
//
// Wear's additions: every item carries `sent_at` (RFC 3339, the phone's clock), which makes each
// send a new DataItem, orders a `remove` against a later download (`removeApplies`) and names the
// item in its receipt; the item paths below; the book key that names a book's item; and the
// `taken` receipt.
//
// Who deletes what (ship-notes, "Data Layer contract changes from check 5"): the watch never
// deletes the phone's `/to/<node>/` items, since a cross-device delete loses to the put by wall
// clock when the phone's clock runs ahead. Once it has kept an item's effect, the watch puts a
// receipt at `/from/<watchnode>/taken/<key>`; the phone deletes its own item when the receipt's
// `path` and `sent_at` match the item it holds, and the watch deletes its receipt once that item is
// gone. The watch reads every `/to/<me>/` item at each start (an item put before install fires no
// change event), skips one its receipt already names, and ignores DELETED under `/to/<me>/`. There
// is no `state-please`: the Data Layer keeps the watch's items for a reinstalled phone app.
package app.audiosilo.wear.core

import java.security.MessageDigest
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/**
 * `<server_id>.<user_id>`: the account a message names and the watch is signed in to (the phone's
 * connection id, `connectionIdOf` in src/lib/connection-id.ts). The one spelling, so the ids
 * compared always agree.
 */
fun accountIdOf(serverId: String, userId: Int): String = "$serverId.$userId"

/** `pair`: sign the watch in (the phone minted the pairing token with `POST /auth/pair {"ttl_seconds":600}`). */
data class PairMessage(
  val serverId: String,
  /** The phone's display label, including the address only for colliding saved server names. */
  val serverName: String,
  val userId: Int,
  val userName: String,
  /** Where to exchange first (the pairing payload's `base_url`). */
  val baseUrl: String,
  /** The phone connection's paired URL. */
  val serverUrl: String,
  val addresses: ServerAddresses,
  val pairingToken: String,
  val expiresAt: Instant,
  val phoneName: String,
) {
  /** The account this message signs in. */
  val accountId: String
    get() = accountIdOf(serverId, userId)

  fun expired(now: Instant): Boolean = now >= expiresAt
}

/**
 * `book`: queue a book for download, like the watch's own Download button. Serializable only for
 * `HeldBooks`'s file; the wire form is decoded below.
 */
@Serializable
data class BookMessage(
  val serverId: String,
  val userId: Int,
  val ref: BookRef,
  val title: String,
  val author: String? = null,
  /** When the phone sent it (Wear; absent from an Apple Watch's message). */
  val sentAt: StoredInstant? = null,
) {
  val accountId: String
    get() = accountIdOf(serverId, userId)
}

/**
 * `remove`: take a book off the watch, as removing it by hand does. Only for the account the watch
 * is signed in to (`HeldBooks.finishRemove`).
 */
data class RemoveMessage(
  val serverId: String,
  val userId: Int,
  val ref: BookRef,
  /** When the phone sent it (Wear): an older remove than the download it would remove is ignored. */
  val sentAt: Instant? = null,
) {
  val accountId: String
    get() = accountIdOf(serverId, userId)
}

sealed interface PhoneMessage {
  data class Pair(val message: PairMessage) : PhoneMessage

  data class Book(val message: BookMessage) : PhoneMessage

  data class Remove(val message: RemoveMessage) : PhoneMessage
}

/** One book on the watch, as `watch-state` reports it. */
data class WatchStateBook(val ref: BookRef, val title: String, val state: State, val bytes: Long? = null) {
  enum class State(val wire: String) {
    QUEUED("queued"),
    PREPARING("preparing"),
    DOWNLOADING("downloading"),
    READY("ready"),
    FAILED("failed");

    /** Still on its way to the watch: what Home lists above Continue listening. */
    val onTheWay: Boolean
      get() = this == QUEUED || this == PREPARING || this == DOWNLOADING
  }
}

/** `watch-state`: the latest only (one DataItem the watch keeps putting). */
data class WatchState(
  val signedIn: Boolean,
  val serverId: String? = null,
  val userId: Int? = null,
  val appVersion: String,
  val books: List<WatchStateBook>,
  val unsentEvents: Int,
  val couldntSync: Int,
  val lastSyncAt: Instant? = null,
)

/** Where each message lives in the Data Layer (W4 plan, "The Data Layer contract"). */
object DataPaths {
  const val ROOT = "/audiosilo/v1/"
  const val WATCH_STATE = "/audiosilo/v1/watch-state"

  /** Every item addressed to any watch starts here (the listener's filter). */
  const val TO_ROOT = "${ROOT}to/"

  /** Every item addressed to watch node `node` starts here. */
  fun to(node: String): String = "$TO_ROOT$node/"

  /** The one `pair` item for `node` (one path, so a new pair replaces an undelivered one). */
  fun pair(node: String): String = "${to(node)}pair"

  /** A book's item for `node`: `book` and `remove` share it, so the latest intent per book wins. */
  fun book(node: String, key: String): String = "${to(node)}book/$key"

  /** What an item path says, when it is addressed to `node`; null for another node's or another path. */
  fun addressed(path: String, node: String): Item? {
    val prefix = to(node)
    if (!path.startsWith(prefix)) return null
    val rest = path.substring(prefix.length)
    if (rest == "pair") return Item.Pair
    if (rest.startsWith("book/") && rest.length > "book/".length && !rest.substring(5).contains('/')) {
      return Item.Book(rest.substring(5))
    }
    return null
  }

  sealed interface Item {
    data object Pair : Item

    data class Book(val key: String) : Item
  }

  /** Every item the watch `node` puts for the phone starts here. */
  fun from(node: String): String = "${ROOT}from/$node/"

  /**
   * The receipt for the phone's item at `itemPath`, put by watch `node`: named by the item's last
   * path segment (`pair`, or a book's key), so each item has one receipt and a new send replaces it.
   */
  fun taken(node: String, itemPath: String): String = "${takenPrefix(node)}${itemPath.substringAfterLast('/')}"

  /** Every receipt watch `node` puts starts here. */
  fun takenPrefix(node: String): String = "${from(node)}taken/"

  /** Whether `path` is one of watch `node`'s receipts. */
  fun isTaken(path: String, node: String): Boolean {
    val prefix = takenPrefix(node)
    return path.startsWith(prefix) && path.length > prefix.length && !path.substring(prefix.length).contains('/')
  }
}

/**
 * `taken`, the watch's receipt for one of the phone's items: `path` is the item's (`/to/...`) path
 * and `sentAt` its `sent_at` exactly as the phone wrote it (echoed as text, so the phone's match is
 * string equality and no clock format can break it). Null `sentAt` for an item that had none.
 */
data class TakenReceipt(val path: String, val sentAt: String?) {
  /** Whether this receipt names the item at `itemPath` sent at `itemSentAt` (so it was handled). */
  fun names(itemPath: String, itemSentAt: String?): Boolean = path == itemPath && sentAt == itemSentAt

  companion object {
    /**
     * The receipt for the item at `itemPath` whose bytes are `itemBytes`, or null for bytes that
     * are not a JSON object (nothing was kept, so nothing to answer).
     */
    fun of(itemPath: String, itemBytes: ByteArray?): TakenReceipt? {
      val m = PhoneMessages.objectOf(itemBytes) ?: return null
      return TakenReceipt(itemPath, PhoneMessages.sentAtText(m))
    }

    /**
     * Whether a receipt can go: the item it names is no longer among `itemsPresent` (the `/to/<me>/`
     * items still there, path to `sent_at` text), because the phone deleted it or put a new one in
     * its place (which gets its own receipt once handled).
     */
    fun settled(receipt: TakenReceipt, itemsPresent: Map<String, String?>): Boolean =
      !(receipt.path in itemsPresent && itemsPresent[receipt.path] == receipt.sentAt)
  }
}

/**
 * The Data Layer key for one book: hex SHA-256 of `<account>|<library_id>|<path>`. It only names
 * the item; path identity is in the payload.
 */
object BookKey {
  fun of(accountId: String, libraryId: Int, path: String): String =
    MessageDigest.getInstance("SHA-256")
      .digest("$accountId|$libraryId|$path".toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
}

object PhoneMessages {
  const val VERSION = 1

  private val JSON = Json { ignoreUnknownKeys = true }

  /** Decode a received message; null for an unknown type, a newer version or a malformed one. */
  fun decode(m: JsonObject): PhoneMessage? {
    if (int(m["v"]) != VERSION) return null
    return when (string(m["type"])) {
      "pair" -> decodePair(m)?.let { PhoneMessage.Pair(it) }
      "book" -> decodeBook(m)?.let { PhoneMessage.Book(it) }
      "remove" -> decodeRemove(m)?.let { PhoneMessage.Remove(it) }
      else -> null
    }
  }

  /** A message given as JSON text: a DataItem's bytes, or the debug sign-in's intent extra. */
  fun decodeJSON(text: String): PhoneMessage? = parseObject(text)?.let(::decode)

  /** A DataItem's bytes (UTF-8 JSON). */
  fun decodeBytes(bytes: ByteArray?): PhoneMessage? = objectOf(bytes)?.let(::decode)

  /** A DataItem's bytes as a JSON object; null when they are not one. */
  fun objectOf(bytes: ByteArray?): JsonObject? = bytes?.let { parseObject(String(it, Charsets.UTF_8)) }

  private fun parseObject(text: String): JsonObject? =
    try {
      JSON.parseToJsonElement(text) as? JsonObject
    } catch (_: Exception) {
      null
    }

  /** An item's `sent_at` as the phone wrote it (text, or a number's own spelling). */
  fun sentAtText(m: JsonObject): String? = (m["sent_at"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

  /** The `taken` receipt as JSON (the bytes of its DataItem). */
  fun encode(r: TakenReceipt): JsonObject = buildJsonObject {
    put("v", VERSION)
    put("type", "taken")
    put("path", r.path)
    r.sentAt?.let { put("sent_at", it) }
  }

  fun encodeBytes(r: TakenReceipt): ByteArray = encode(r).toString().toByteArray(Charsets.UTF_8)

  /** One of the watch's own receipts read back (at start, to skip what it already handled). */
  fun decodeReceipt(bytes: ByteArray?): TakenReceipt? {
    val m = objectOf(bytes) ?: return null
    if (int(m["v"]) != VERSION || string(m["type"]) != "taken") return null
    val path = nonEmpty(m["path"]) ?: return null
    return TakenReceipt(path, string(m["sent_at"]))
  }

  private fun decodePair(m: JsonObject): PairMessage? {
    val serverId = nonEmpty(m["server_id"]) ?: return null
    val userId = int(m["user_id"]) ?: return null
    val base = httpURL(m["base_url"]) ?: return null
    val token = nonEmpty(m["pairing_token"]) ?: return null
    val expires = date(m["expires_at"]) ?: return null
    val addrs = m["addresses"] as? JsonObject
    return PairMessage(
      serverId = serverId,
      serverName = string(m["server_name"]) ?: "",
      userId = userId,
      userName = string(m["user_name"]) ?: "",
      baseUrl = base,
      serverUrl = httpURL(m["server_url"]) ?: base,
      addresses = ServerAddresses(httpURL(addrs?.get("home")), httpURL(addrs?.get("away"))),
      pairingToken = token,
      expiresAt = expires,
      phoneName = string(m["phone_name"]) ?: "",
    )
  }

  private fun decodeBook(m: JsonObject): BookMessage? {
    val serverId = nonEmpty(m["server_id"]) ?: return null
    val userId = int(m["user_id"]) ?: return null
    val lib = int(m["library_id"]) ?: return null
    val path = nonEmpty(m["path"]) ?: return null
    return BookMessage(
      serverId = serverId,
      userId = userId,
      ref = BookRef(lib, path),
      title = string(m["title"]) ?: path,
      author = nonEmpty(m["author"]),
      sentAt = date(m["sent_at"]),
    )
  }

  private fun decodeRemove(m: JsonObject): RemoveMessage? =
    decodeBook(m)?.let { RemoveMessage(it.serverId, it.userId, it.ref, it.sentAt) }

  /**
   * Whether a `remove` takes a download queued at `downloadAt` (the book message's `sent_at`, else
   * when the watch queued it): not when the remove is older (W3c's follow-up, solved for Wear). A
   * remove or a download with no time (an older phone) applies, as on the Apple Watch.
   */
  fun removeApplies(remove: RemoveMessage, downloadAt: Instant?): Boolean {
    val sent = remove.sentAt ?: return true
    val queued = downloadAt ?: return true
    return !sent.isBefore(queued)
  }

  /** `watch-state` as JSON (the bytes of its DataItem). */
  fun encode(s: WatchState): JsonObject = buildJsonObject {
    put("v", VERSION)
    put("type", "watch-state")
    put("signed_in", s.signedIn)
    put("app_version", s.appVersion)
    put("unsent_events", s.unsentEvents)
    put("couldnt_sync", s.couldntSync)
    put(
      "books",
      buildJsonArray {
        for (b in s.books) {
          add(
            buildJsonObject {
              put("library_id", b.ref.libraryId)
              put("path", b.ref.path)
              put("title", b.title)
              put("state", b.state.wire)
              b.bytes?.let { put("bytes", it) }
            }
          )
        }
      },
    )
    s.serverId?.let { put("server_id", it) }
    s.userId?.let { put("user_id", it) }
    s.lastSyncAt?.let { put("last_sync_at", ISOTime.string(it)) }
  }

  fun encodeBytes(s: WatchState): ByteArray = encode(s).toString().toByteArray(Charsets.UTF_8)

  // Reading JSON values

  fun int(v: JsonElement?): Int? {
    val p = v as? JsonPrimitive ?: return null
    if (p.isString) return p.content.toIntOrNull()
    val d = p.doubleOrNull ?: return null
    return if (d == kotlin.math.floor(d) && d >= Int.MIN_VALUE && d <= Int.MAX_VALUE) d.toInt() else null
  }

  private fun string(v: JsonElement?): String? = (v as? JsonPrimitive)?.takeIf { it.isString }?.content

  private fun nonEmpty(v: JsonElement?): String? = string(v)?.takeIf { it.isNotBlank() }

  private fun httpURL(v: JsonElement?): String? {
    val s = nonEmpty(v) ?: return null
    val e = URLEndpoint.parse(s) ?: return null
    return if (e.scheme == "http" || e.scheme == "https") s else null
  }

  /** An RFC 3339 string, or seconds since 1970. */
  private fun date(v: JsonElement?): Instant? {
    val p = v as? JsonPrimitive ?: return null
    if (p.isString) return ISOTime.parse(p.content)
    return p.doubleOrNull?.let(::instantAt)
  }
}
