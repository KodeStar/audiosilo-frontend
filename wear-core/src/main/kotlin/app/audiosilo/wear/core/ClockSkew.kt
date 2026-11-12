// How far the server's clock is ahead of the watch's, a port of targets/watch/Core/ClockSkew.swift
// (`clockSkewOf` in listening-outbox.ts). Every Wear body is built as it is sent and carries
// `sent_at` (decision 9), so only the measurement is ported: the Apple Watch's `clock_offset` is
// for a body built earlier (its background upload), which Wear never sends.
package app.audiosilo.wear.core

import java.time.Instant

object ClockSkew {
  /**
   * Milliseconds the server's clock was ahead of the watch's, measured from an answer's
   * `server_time` against the middle of the request; null without a readable time.
   */
  fun of(serverTime: String?, sentAt: Instant, answeredAt: Instant): Double? {
    val server = serverTime?.let(ISOTime::parse) ?: return null
    val middle = (sentAt.epochSeconds + answeredAt.epochSeconds) / 2
    return roundHalfAway((server.epochSeconds - middle) * 1000)
  }
}
