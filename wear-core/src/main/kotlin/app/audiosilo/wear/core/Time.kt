// Times as the watch reads, writes and stores them. Foundation's `Date` arithmetic in the Swift
// Core is seconds as a Double; these helpers keep the Kotlin port reading the same way.
package app.audiosilo.wear.core

import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.floor
import kotlin.math.roundToLong
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/** The instant `seconds` after this one (negative: before). */
fun Instant.addingSeconds(seconds: Double): Instant {
  val whole = floor(seconds)
  return plusSeconds(whole.toLong()).plusNanos(((seconds - whole) * 1e9).roundToLong())
}

/** Seconds from `other` to this instant (negative when this one is earlier). */
fun Instant.secondsSince(other: Instant): Double =
  (epochSecond - other.epochSecond) + (nano - other.nano) / 1e9

/** Seconds since 1970 as a Double. */
val Instant.epochSeconds: Double
  get() = epochSecond + nano / 1e9

/** The instant `seconds` after 1970. */
fun instantAt(seconds: Double): Instant = Instant.EPOCH.addingSeconds(seconds)

/**
 * RFC 3339 times as the phone writes them (`Date.toISOString()`: UTC, milliseconds), and a lenient
 * read of the server's (Go's RFC3339Nano: any number of fraction digits, or none).
 */
object ISOTime {
  private val writer: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

  fun string(instant: Instant): String = writer.format(instant)

  fun parse(s: String): Instant? {
    // Split off the fraction (any length), read the rest, add the fraction back.
    val t = s.indexOf('T')
    if (t < 0) return null
    var whole = s
    var fraction = 0.0
    val dot = s.indexOf('.', t)
    if (dot >= 0) {
      var end = dot + 1
      while (end < s.length && s[end].isDigit()) end++
      fraction = ("0" + s.substring(dot, end)).toDoubleOrNull() ?: 0.0
      whole = s.substring(0, dot) + s.substring(end)
    }
    val base =
      try {
        OffsetDateTime.parse(whole, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant()
      } catch (_: Exception) {
        return null
      }
    return base.addingSeconds(fraction)
  }
}

/** An `Instant` in the watch's own files: ISO-8601 with nanoseconds, so it reads back exactly. */
object InstantSerializer : KSerializer<Instant> {
  override val descriptor = PrimitiveSerialDescriptor("app.audiosilo.Instant", PrimitiveKind.STRING)

  override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(value.toString())

  override fun deserialize(decoder: Decoder): Instant = Instant.parse(decoder.decodeString())
}

/** An `Instant` field of a stored document. */
typealias StoredInstant = @Serializable(with = InstantSerializer::class) Instant
