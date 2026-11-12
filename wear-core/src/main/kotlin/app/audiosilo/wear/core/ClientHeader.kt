// The watch's identity on every request, a port of targets/watch/Core/ClientHeader.swift (W4
// decision 11, CROSS-REPO section 20): `X-AudioSilo-Client: audiosilo-watch/<versionName> (wearos)`.
// The server keeps it per token (`auth.ParseClient`), so the console names the watch, and an app
// that is not "AudioSilo" sees no podcast libraries.
package app.audiosilo.wear.core

object ClientHeader {
  const val NAME = "X-AudioSilo-Client"
  const val APP = "audiosilo-watch"
  const val PLATFORM = "wearos"

  private const val ALLOWED = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+_-"

  /**
   * The header value for this build's version. A version the server's pattern would refuse
   * (`[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}`) is reduced to the characters it takes, else "0".
   */
  fun value(version: String?): String {
    val v = (version ?: "").filter { it in ALLOWED }.take(32).dropWhile { !it.isLetterOrDigit() }
    return "$APP/${v.ifEmpty { "0" }} ($PLATFORM)"
  }
}
