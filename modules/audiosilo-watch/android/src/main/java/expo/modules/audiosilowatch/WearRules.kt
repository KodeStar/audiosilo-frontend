// The phone's side of the Wear OS Data Layer contract, pure (no android.*, no Play services), so
// the JVM tests cover it. The watch's side is wear-core's PhoneMessages.kt (DataPaths, BookKey,
// TakenReceipt) and wear/.../phone/PhoneLink.kt; the messages themselves are built in
// src/watch/watch-model.ts. WearLink.kt is the only caller.
//
// The contract (W4 plan "The Data Layer contract", with ship-notes "Data Layer contract changes
// from check 5"):
//  - the phone puts `pair` at `/audiosilo/v1/to/<watchnode>/pair` and `book`/`remove` at
//    `/audiosilo/v1/to/<watchnode>/book/<key>` (one path per book, so the latest intent wins), each
//    a DataItem of UTF-8 JSON carrying `sent_at`;
//  - the watch never deletes those: once it has kept an item's effect it puts its receipt at
//    `/audiosilo/v1/from/<watchnode>/taken/<last segment>` = `{v:1, type:"taken", path, sent_at}`,
//    and the phone deletes its own item when the receipt's path and `sent_at` match the item it
//    holds (a newer send at that path stays); the watch then drops its receipt;
//  - "not delivered yet" is the phone's own item still there; nothing is ever `failed`;
//  - the watch puts `/audiosilo/v1/watch-state` (latest only) and advertises the capability
//    `audiosilo_wear_app`; the phone advertises `audiosilo_phone_app` (res/values/wear.xml).
package expo.modules.audiosilowatch

import java.security.MessageDigest
import java.text.ParseException
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

object WearPaths {
  const val ROOT = "/audiosilo/v1/"
  const val WATCH_STATE = "/audiosilo/v1/watch-state"

  /** Every item the phone addresses to any watch starts here. */
  const val TO = "${ROOT}to/"

  /** Every item any watch puts for the phone starts here (the listener service's filter). */
  const val FROM = "${ROOT}from/"

  /** The `pair` item's place under a watch's `to(node)`. */
  const val PAIR = "pair"

  /** Where the book items sit under a watch's `to(node)`. */
  const val BOOKS = "book/"

  /** What the Wear app advertises (wear/src/main/res/values/wear.xml). */
  const val WEAR_CAPABILITY = "audiosilo_wear_app"

  /** Every item the phone addresses to watch node `node` starts here. */
  fun to(node: String): String = "$TO$node/"

  /** The one `pair` item for `node`. */
  fun pair(node: String): String = to(node) + PAIR

  /** A book's item for `node`, shared by `book` and `remove`. */
  fun book(node: String, key: String): String = to(node) + BOOKS + key

  /** Every item watch node `node` puts for the phone starts here (its receipts). */
  fun from(node: String): String = "$FROM$node/"

  /** Whether `path` is one of watch `node`'s receipts. */
  fun isTaken(path: String, node: String): Boolean {
    val prefix = "${from(node)}taken/"
    return path.startsWith(prefix) && path.length > prefix.length && !path.substring(prefix.length).contains('/')
  }

  /** Whether `path` is an item the phone addresses to `node` (its `pair` or a book's). */
  fun isAddressedTo(path: String, node: String): Boolean {
    val rest = path.removePrefix(to(node)).takeIf { it.length < path.length } ?: return false
    if (rest == PAIR) return true
    val key = rest.removePrefix(BOOKS).takeIf { it.length < rest.length } ?: return false
    return key.isNotEmpty() && !key.contains('/')
  }

  /** The watch node an item path is addressed to, null for any other path. */
  fun addressee(path: String): String? {
    val rest = path.removePrefix(TO).takeIf { it.length < path.length } ?: return null
    val node = rest.substringBefore('/')
    return node.takeIf { it.isNotEmpty() && isAddressedTo(path, it) }
  }
}

/**
 * The key naming one book's item: hex SHA-256 of `<server_id>.<user_id>|<library_id>|<path>`, as
 * the watch's `BookKey.of` (it only names the item; the payload carries the identity).
 */
object BookKey {
  fun of(serverId: String, userId: Long, libraryId: Long, path: String): String =
    MessageDigest.getInstance("SHA-256")
      .digest("$serverId.$userId|$libraryId|$path".toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
}

/** One Data Layer item as read: its path and its payload as decoded JSON (null if not an object). */
data class Item(val path: String, val payload: Map<String, Any?>?)

/** A watch the Data Layer knows of: connected now, nearby or by the cloud. */
data class WatchNode(val id: String, val nearby: Boolean)

/** Everything the snapshot is made of, read from the Data Layer by WearLink. */
data class LinkView(
  /** The Wearable API answers (no Wear OS app on the phone means no). */
  val apiAvailable: Boolean,
  val connected: List<WatchNode>,
  /** The nodes advertising `audiosilo_wear_app`, connected or not. */
  val capable: Set<String>,
  /** Each node's `watch-state`, decoded. */
  val states: Map<String, Map<String, Any?>>,
  /** When this phone last saw each node put a `watch-state`, epoch ms (kept across launches). */
  val stateSeenAt: Map<String, Long>,
  /** The phone's own items under `/audiosilo/v1/to/`. */
  val own: List<Item>,
) {
  companion object {
    val NONE = LinkView(false, emptyList(), emptySet(), emptyMap(), emptyMap(), emptyList())
  }
}

/** The `taken` receipt a watch puts for one of the phone's items. */
data class Receipt(val path: String, val sentAt: String?)

object WearRules {
  const val VERSION = 1

  /**
   * The one watch the phone talks to (W4 decision 13, one watch at a time): of the nodes with the
   * app (the capability, or a `watch-state`), the one whose `watch-state` this phone saw last, else
   * a connected one nearby, else a connected one, else any. Null with no app on any watch. Ties go
   * by node id, so the choice is stable.
   */
  fun target(view: LinkView): String? {
    val withApp = (view.capable + view.states.keys).sorted()
    if (withApp.isEmpty()) return null
    withApp.filter { it in view.stateSeenAt }.maxByOrNull { view.stateSeenAt.getValue(it) }?.let { return it }
    val connected = view.connected.filter { it.id in withApp }.sortedBy { it.id }
    return connected.firstOrNull { it.nearby }?.id ?: connected.firstOrNull()?.id ?: withApp.first()
  }

  /**
   * What `getSnapshot` answers (`NativeWatchSnapshot` in modules/audiosilo-watch/index.ts):
   * `paired` (the API answers and a watch is connected or has a `watch-state`), `installed` (a
   * target with the app), `watch_id` (the target's node id), `state` (its `watch-state`) and
   * `outstanding` (the `book`s and `remove`s still held for it: not taken by the watch app yet).
   * Never a `pair` (it carries a token) and never `failed` (an item waits for the watch).
   */
  fun snapshot(view: LinkView): Map<String, Any?> {
    if (!view.apiAvailable) return mapOf("paired" to false, "installed" to false, "outstanding" to emptyList<Any>())
    val target = target(view)
    val out =
      mutableMapOf<String, Any?>(
        "paired" to (view.connected.isNotEmpty() || view.states.isNotEmpty()),
        "installed" to (target != null),
        "outstanding" to if (target != null) outstanding(view.own, target) else emptyList(),
      )
    if (target != null) {
      out["watch_id"] = target
      view.states[target]?.let { out["state"] = it }
    }
    return out
  }

  /** The `book`s and `remove`s held for `node`, named by account and book only. */
  fun outstanding(own: List<Item>, node: String): List<Map<String, Any?>> =
    own
      .filter { it.path.startsWith(WearPaths.to(node) + WearPaths.BOOKS) && WearPaths.isAddressedTo(it.path, node) }
      .mapNotNull { item ->
        val m = item.payload ?: return@mapNotNull null
        val type = m["type"] as? String
        if (type != "book" && type != "remove") return@mapNotNull null
        val book = bookOf(m) ?: return@mapNotNull null
        mapOf(
          "type" to type,
          "server_id" to book.serverId,
          "user_id" to book.userId,
          "library_id" to book.libraryId,
          "path" to book.path,
        )
      }

  /** The book a `book` or `remove` names: what its item's key is made of. */
  private class NamedBook(val serverId: String, val userId: Long, val libraryId: Long, val path: String)

  private fun bookOf(m: Map<String, Any?>): NamedBook? {
    val serverId = (m["server_id"] as? String)?.takeIf { it.isNotEmpty() } ?: return null
    val userId = integer(m["user_id"]) ?: return null
    val libraryId = integer(m["library_id"]) ?: return null
    val path = (m["path"] as? String)?.takeIf { it.isNotEmpty() } ?: return null
    return NamedBook(serverId, userId, libraryId, path)
  }

  /**
   * Where a message goes under the target watch's `WearPaths.to(node)` (`pair`, or `book/<key>`),
   * or null for one that is not a `v: 1` `pair`, `book` or `remove` naming what its path needs, or
   * that has no `sent_at` (without it an identical send would put nothing, and the receipt could
   * not name it).
   */
  fun slot(message: Map<String, Any?>): String? {
    if (integer(message["v"]) != VERSION.toLong()) return null
    if ((message["sent_at"] as? String).isNullOrEmpty()) return null
    return when (message["type"]) {
      "pair" -> WearPaths.PAIR
      "book", "remove" ->
        bookOf(message)?.let { WearPaths.BOOKS + BookKey.of(it.serverId, it.userId, it.libraryId, it.path) }
      else -> null
    }
  }

  /** A receipt's payload, null for anything that is not one. */
  fun receipt(payload: Map<String, Any?>?): Receipt? {
    if (payload == null || integer(payload["v"]) != VERSION.toLong() || payload["type"] != "taken") return null
    val path = (payload["path"] as? String)?.takeIf { it.isNotEmpty() } ?: return null
    return Receipt(path, sentAtText(payload["sent_at"]))
  }

  /**
   * The phone's item a receipt at `receiptPath` from watch `node` lets it delete, or null: the
   * receipt must be that watch's own and name an item addressed to that very watch (no node can
   * clear another's items), and the item the phone holds there must carry the `sent_at` it names
   * (a newer send at the same path stays until its own receipt). `held`: the phone's item at the
   * receipt's path, if any.
   */
  fun deletable(receiptPath: String, node: String, receipt: Receipt, held: Item?): String? {
    if (!WearPaths.isTaken(receiptPath, node)) return null
    if (!WearPaths.isAddressedTo(receipt.path, node)) return null
    if (receiptPath.substringAfterLast('/') != receipt.path.substringAfterLast('/')) return null
    if (held == null || held.path != receipt.path) return null
    return if (sentAtText(held.payload?.get("sent_at")) == receipt.sentAt) held.path else null
  }

  /**
   * The phone's items to delete at `now` (epoch ms): every `pair` past its `expires_at` (or with
   * none readable), so a pairing token never lingers past its life on any watch, and, when a new
   * pair goes to `sendingTo`, the pairs held for other watches (one watch at a time: the last pair
   * is the one that counts, as a new pair cancels an undelivered one on iOS).
   */
  fun stalePairs(own: List<Item>, now: Long, sendingTo: String? = null): List<String> =
    own
      .filter { item ->
        val node = WearPaths.addressee(item.path) ?: return@filter false
        if (item.path != WearPaths.pair(node)) return@filter false
        if (sendingTo != null && node != sendingTo) return@filter true
        val expires = (item.payload?.get("expires_at") as? String)?.let(::epochMs) ?: return@filter true
        now >= expires
      }
      .map { it.path }

  /** An RFC 3339 time (as JavaScript's `toISOString` writes it, or without the milliseconds) in epoch ms. */
  fun epochMs(text: String): Long? {
    for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX")) {
      val format = SimpleDateFormat(pattern, Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
        isLenient = false
      }
      try {
        return format.parse(text)?.time
      } catch (_: ParseException) {
        // the next pattern
      }
    }
    return null
  }

  /** `sent_at` as the watch echoes it: a string's own text, a number's spelling. */
  fun sentAtText(v: Any?): String? =
    when (v) {
      null -> null
      is String -> v
      is Number -> Json.number(v)
      is Boolean -> v.toString()
      else -> null
    }

  /** A whole number however the bridge or the parser gave it (JS numbers arrive as Double). */
  fun integer(v: Any?): Long? =
    when (v) {
      is Long -> v
      is Double -> if (v == Math.floor(v) && !v.isInfinite() && Math.abs(v) <= 9.007199254740991E15) v.toLong() else null
      is Number -> integer(v.toDouble())
      else -> null
    }
}

/**
 * JSON for the items, with no library, so the JVM tests and the device read and write the same
 * way: objects (as maps in their order), arrays (lists), strings, numbers (a whole one as a Long; a
 * whole Double is written as an integer, since the JS bridge gives every number as a Double),
 * booleans and null.
 */
object Json {
  fun encode(v: Any?): String = StringBuilder().also { write(it, v) }.toString()

  /** A DataItem's bytes as a JSON object, null when they are not one. */
  fun decodeObject(bytes: ByteArray?): Map<String, Any?>? {
    if (bytes == null) return null
    return try {
      @Suppress("UNCHECKED_CAST")
      Parser(String(bytes, Charsets.UTF_8)).document() as? Map<String, Any?>
    } catch (_: IllegalArgumentException) {
      null
    }
  }

  private class Parser(private val s: String) {
    private var i = 0

    fun document(): Any? {
      val v = value()
      space()
      require(i == s.length) { "trailing text" }
      return v
    }

    private fun space() {
      while (i < s.length && s[i] in " \t\r\n") i++
    }

    private fun value(): Any? {
      space()
      require(i < s.length) { "end of text" }
      return when (val c = s[i]) {
        '{' -> obj()
        '[' -> arr()
        '"' -> str()
        't' -> word("true", true)
        'f' -> word("false", false)
        'n' -> word("null", null)
        else -> if (c == '-' || c in '0'..'9') num() else throw IllegalArgumentException("unexpected $c")
      }
    }

    private fun word(w: String, v: Any?): Any? {
      require(s.startsWith(w, i)) { "bad literal" }
      i += w.length
      return v
    }

    private fun obj(): Map<String, Any?> {
      val out = LinkedHashMap<String, Any?>()
      i++
      space()
      if (i < s.length && s[i] == '}') return out.also { i++ }
      while (true) {
        space()
        require(i < s.length && s[i] == '"') { "key expected" }
        val k = str()
        space()
        require(i < s.length && s[i] == ':') { "colon expected" }
        i++
        out[k] = value()
        space()
        require(i < s.length) { "end of text" }
        if (s[i] == ',') {
          i++
          continue
        }
        require(s[i] == '}') { "comma or brace expected" }
        i++
        return out
      }
    }

    private fun arr(): List<Any?> {
      val out = ArrayList<Any?>()
      i++
      space()
      if (i < s.length && s[i] == ']') return out.also { i++ }
      while (true) {
        out.add(value())
        space()
        require(i < s.length) { "end of text" }
        if (s[i] == ',') {
          i++
          continue
        }
        require(s[i] == ']') { "comma or bracket expected" }
        i++
        return out
      }
    }

    private fun str(): String {
      val sb = StringBuilder()
      i++
      while (true) {
        require(i < s.length) { "unterminated string" }
        val c = s[i++]
        when {
          c == '"' -> return sb.toString()
          c == '\\' -> {
            require(i < s.length) { "bad escape" }
            when (val e = s[i++]) {
              '"', '\\', '/' -> sb.append(e)
              'b' -> sb.append('\b')
              'f' -> sb.append('\u000C')
              'n' -> sb.append('\n')
              'r' -> sb.append('\r')
              't' -> sb.append('\t')
              'u' -> {
                require(i + 4 <= s.length) { "bad escape" }
                sb.append(s.substring(i, i + 4).toIntOrNull(16)?.toChar() ?: throw IllegalArgumentException("bad escape"))
                i += 4
              }
              else -> throw IllegalArgumentException("bad escape")
            }
          }
          c < ' ' -> throw IllegalArgumentException("control character")
          else -> sb.append(c)
        }
      }
    }

    private fun num(): Number {
      val start = i
      if (s[i] == '-') i++
      while (i < s.length && (s[i].isDigit() || s[i] in ".eE+-")) i++
      val text = s.substring(start, i)
      if (text.all { it.isDigit() || it == '-' }) text.toLongOrNull()?.let { return it }
      return text.toDoubleOrNull() ?: throw IllegalArgumentException("bad number")
    }
  }

  fun number(n: Number): String {
    val d = n.toDouble()
    if (d.isNaN() || d.isInfinite()) return "null"
    WearRules.integer(n)?.let { return it.toString() }
    return d.toString()
  }

  private fun write(sb: StringBuilder, v: Any?) {
    when (v) {
      null -> sb.append("null")
      is String -> string(sb, v)
      is Boolean -> sb.append(v)
      is Number -> sb.append(number(v))
      is Map<*, *> -> {
        sb.append('{')
        var first = true
        for ((k, value) in v) {
          if (!first) sb.append(',')
          first = false
          string(sb, k.toString())
          sb.append(':')
          write(sb, value)
        }
        sb.append('}')
      }
      is Iterable<*> -> {
        sb.append('[')
        v.forEachIndexed { i, value ->
          if (i > 0) sb.append(',')
          write(sb, value)
        }
        sb.append(']')
      }
      is Array<*> -> write(sb, v.asList())
      else -> string(sb, v.toString())
    }
  }

  private fun string(sb: StringBuilder, s: String) {
    sb.append('"')
    for (c in s) {
      when (c) {
        '"' -> sb.append("\\\"")
        '\\' -> sb.append("\\\\")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        '\b' -> sb.append("\\b")
        '\u000C' -> sb.append("\\f")
        else -> if (c < ' ' || c == '\u2028' || c == '\u2029') sb.append("\\u%04x".format(c.code)) else sb.append(c)
      }
    }
    sb.append('"')
  }
}
