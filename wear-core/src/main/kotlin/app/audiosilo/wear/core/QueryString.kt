// A request's query string, encoded by hand (a port of targets/watch/Core/QueryString.swift). Go
// (1.17 and later) drops any query pair holding a raw `;`, so a book path with one would reach the
// server as no `path` at all, and a raw `+` reads as a space. Every character but RFC 3986's
// unreserved ones is percent-encoded as UTF-8 (the phone's URLSearchParams encodes `;` too).
package app.audiosilo.wear.core

object QueryString {
  /** `name=value` pairs sorted by name, joined with `&`. */
  fun encode(query: Map<String, String>): String =
    query.entries.sortedBy { it.key }.joinToString("&") { "${escape(it.key)}=${escape(it.value)}" }

  /** One name or value, percent-encoded as UTF-8. */
  fun escape(s: String): String {
    val out = StringBuilder()
    for (b in s.toByteArray(Charsets.UTF_8)) {
      val c = b.toInt() and 0xff
      if (unreserved(c)) out.append(c.toChar()) else out.append('%').append(HEX[c shr 4]).append(HEX[c and 0xf])
    }
    return out.toString()
  }

  /** The unreserved characters (RFC 3986 section 2.3), the only ones sent as they are. */
  private fun unreserved(c: Int): Boolean =
    c in 'A'.code..'Z'.code || c in 'a'.code..'z'.code || c in '0'.code..'9'.code || c == '-'.code || c == '.'.code || c == '_'.code || c == '~'.code

  private const val HEX = "0123456789ABCDEF"
}
