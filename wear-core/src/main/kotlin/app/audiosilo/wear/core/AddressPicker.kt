// Which address the watch talks to, a port of targets/watch/Core/AddressPicker.swift (itself the
// phone's `src/lib/server-address.ts` (`chooseAddress`, `pickAddress`, `mergeAddresses`),
// `src/lib/url-host.ts` (`urlEndpoint`) and `src/components/connect/connect-model.ts`
// (`withFallback`, `pairingFallback`)). CROSS-REPO section 7: a home address is used only after a
// tokenless `GET <home>/api/v1/server` answered this account's `server_id`; NEVER does a token
// (session or pairing) go to a home address before that. Self-signed (W4 decision 4): no
// certificate override; the server's plain-HTTP home address is the way in at home, under
// `pairingFallback`'s rule.
package app.audiosilo.wear.core

import kotlinx.coroutines.CancellationException

/** An absolute URL's scheme, host and port (the port defaulting to the scheme's). */
data class URLEndpoint(val scheme: String, val host: String, val port: String) {
  companion object {
    fun parse(url: String): URLEndpoint? {
      val s = url.trim()
      val schemeEnd = s.indexOf("://")
      if (schemeEnd < 0) return null
      val scheme = s.substring(0, schemeEnd).lowercase()
      val first = scheme.firstOrNull() ?: return null
      if (!first.isLetter() || !scheme.all { it.isLetterOrDigit() || it in "+.-" }) return null
      var rest = s.substring(schemeEnd + 3)
      val stop = rest.indexOfFirst { it in "/?#" }
      if (stop >= 0) rest = rest.substring(0, stop)
      val at = rest.lastIndexOf('@')
      if (at >= 0) rest = rest.substring(at + 1)
      val host: String
      var port: String? = null
      if (rest.startsWith("[")) {
        val close = rest.indexOf(']')
        if (close < 0) return null
        host = rest.substring(1, close)
        val after = rest.substring(close + 1)
        if (after.startsWith(":")) port = after.substring(1)
      } else {
        val colon = rest.indexOf(':')
        if (colon >= 0) {
          host = rest.substring(0, colon)
          port = rest.substring(colon + 1)
        } else {
          host = rest
        }
      }
      if (host.isEmpty()) return null
      if (port != null && (port.isEmpty() || !port.all { it.isDigit() })) return null
      val defaultPort =
        when (scheme) {
          "https" -> "443"
          "http" -> "80"
          else -> ""
        }
      return URLEndpoint(scheme, host.lowercase(), port ?: defaultPort)
    }
  }
}

/** Asks an address who it is with NO token; the `server_id` it answered, else null. Never throws. */
typealias ServerIdProbe = suspend (String) -> String?

/** An exchange's answer and the base that gave it. */
data class Exchanged<T>(val answer: T, val base: String)

object AddressPicker {
  /** Two URLs say the same, trailing slashes aside. */
  fun sameURL(a: String, b: String): Boolean = trimSlashes(a) == trimSlashes(b)

  fun trimSlashes(s: String): String = s.trim().trimEnd('/')

  /** The address when home is not an option: away, else the paired URL. */
  fun fallback(serverURL: String, addresses: ServerAddresses?): String = addresses?.away ?: serverURL

  /**
   * The address before anything was probed: what a home that did not answer leaves, so the token
   * never goes to a home address unproven while another is known.
   */
  fun unproven(serverURL: String, addresses: ServerAddresses?): String =
    if (addresses?.home == null) serverURL else fallback(serverURL, addresses)

  /**
   * The pick, given what home answered (`homeServerId`, null for no answer): home only on this
   * account's own `server_id`; no home address keeps the paired URL.
   */
  fun choose(serverURL: String, addresses: ServerAddresses?, serverId: String, homeServerId: String?): String {
    val home = addresses?.home ?: return serverURL
    if (homeServerId != null && homeServerId == serverId) return home
    return fallback(serverURL, addresses)
  }

  /** Pick now: probe home (when there is one, with no token), then `choose`. */
  suspend fun pick(serverURL: String, addresses: ServerAddresses?, serverId: String, probe: ServerIdProbe): String {
    val home = addresses?.home ?: return serverURL
    return choose(serverURL, addresses, serverId, probe(home))
  }

  /**
   * What the watch keeps after the server told it `fresh`, given what it knew before (the phone's
   * `mergeAddresses`). Null `fresh` keeps `prior`. Otherwise `away` is the server's configuration
   * (absent = none) while `home` falls back to `prior`'s: a server with no home address configured
   * derives it from the request, so an answer read through the away address cannot know it. A home
   * that became the away address is dropped; empty counts as absent.
   */
  fun merge(prior: ServerAddresses?, fresh: ServerAddresses?): ServerAddresses? {
    if (fresh == null) return prior
    val away = fresh.away?.ifEmpty { null }
    var home = (fresh.home ?: prior?.home)?.ifEmpty { null }
    if (home != null && away != null && sameURL(home, away)) home = null
    if (home == null && away == null) return null
    return ServerAddresses(home, away)
  }

  /** Whether `url` is one of the account's own addresses (a pick that no longer is falls back). */
  fun isOwn(url: String, serverURL: String, addresses: ServerAddresses?): Boolean =
    sameURL(url, serverURL) ||
      addresses?.home?.let { sameURL(url, it) } == true ||
      addresses?.away?.let { sameURL(url, it) } == true

  /**
   * Where to exchange when `base` could not connect without a server answering (and not a timeout):
   * the `home` address, only when it is plain http on the base's own https host and port and, asked
   * with no token, answers as exactly `serverId`. Else null.
   */
  suspend fun pairingFallback(
    base: String,
    home: String?,
    serverId: String?,
    timedOut: Boolean,
    probe: ServerIdProbe,
  ): String? {
    if (home == null || serverId.isNullOrEmpty() || timedOut) return null
    val b = URLEndpoint.parse(base) ?: return null
    val h = URLEndpoint.parse(home) ?: return null
    if (b.scheme != "https" || h.scheme != "http") return null
    if (h.host != b.host || h.port != b.port) return null
    return if (probe(home) == serverId) home else null
  }

  /**
   * Exchange a pairing token (W4 decision 12: the pair message's `base_url`, then `away`, then the
   * home http address under `pairingFallback`'s rule). A server's own answer (`APIError`) at any
   * address ends it: the token is single use. `attempt` exchanges at a base; `isTimeout` tells a
   * timeout from other failures. Returns the answer and the base that gave it.
   */
  suspend fun <T> exchange(
    base: String,
    addresses: ServerAddresses?,
    serverId: String,
    attempt: suspend (String) -> T,
    isTimeout: (Throwable) -> Boolean,
    probe: ServerIdProbe,
  ): Exchanged<T> {
    val firstError: Exception
    try {
      return Exchanged(attempt(base), base)
    } catch (e: APIError) {
      throw e
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      firstError = e
    }
    val away = addresses?.away
    if (away != null && !sameURL(away, base)) {
      try {
        return Exchanged(attempt(away), away)
      } catch (e: APIError) {
        throw e
      } catch (e: CancellationException) {
        throw e
      } catch (_: Exception) {}
    }
    val home = pairingFallback(base, addresses?.home, serverId, isTimeout(firstError), probe)
    if (home != null) {
      try {
        return Exchanged(attempt(home), home)
      } catch (e: APIError) {
        throw e
      } catch (e: CancellationException) {
        throw e
      } catch (_: Exception) {}
    }
    throw firstError
  }
}
