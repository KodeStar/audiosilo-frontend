package expo.modules.audiosiloplayer

/**
 * The rules [AuthHolder] applies, with no Android types so they are unit tested: which origin
 * a URL is, and which of a book's headers may go to it.
 */
internal object AuthScope {
  /** `scheme://host:port`, lower-cased, with the scheme's default port when none is named
   * (`port` -1); null without a scheme or a host. */
  fun origin(scheme: String?, host: String?, port: Int): String? {
    val s = scheme?.lowercase() ?: return null
    val h = host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
    val p = when {
      port != -1 -> port
      s == "https" -> 443
      s == "http" -> 80
      else -> -1
    }
    return "$s://$h:$p"
  }

  /**
   * What of a book's [headers] may go to [origin]: every one to an https origin; to any other,
   * only the session token (`Authorization`, which the app sends a server on the house network
   * over plain http too), never a proxy header (fe#295). The JS side already sends a proxy set
   * to its https origin only (`proxyHeaderRecord`); this holds the same line on its own, so a
   * set handed over with an http track never crosses the network in the clear. Null when
   * nothing is left.
   */
  fun headersFor(origin: String, headers: Map<String, String>?): Map<String, String>? {
    if (headers.isNullOrEmpty()) return null
    val kept = if (origin.startsWith("https://")) {
      headers
    } else {
      headers.filterKeys { it.equals("Authorization", ignoreCase = true) }
    }
    return kept.takeIf { it.isNotEmpty() }
  }
}
