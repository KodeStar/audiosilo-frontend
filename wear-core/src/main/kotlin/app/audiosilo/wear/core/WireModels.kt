// The server's JSON as the watch reads and sends it, a port of targets/watch/Core/WireModels.swift
// (itself mirrored by hand from the phone's `src/api/types.ts`; there is no codegen: a wire change
// touches every side).
//
// Keys are snake_case on the wire and camelCase here (`Wire.json`). A null is left out of an
// encoded body (`explicitNulls = false`), as Codable's `encodeIfPresent`.
package app.audiosilo.wear.core

import java.time.Instant
import kotlin.math.min
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonNamingStrategy
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The coder every wire read and write goes through. */
object Wire {
  @OptIn(ExperimentalSerializationApi::class)
  val json: Json = Json {
    namingStrategy = JsonNamingStrategy.SnakeCase
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
  }
}

// Server

@Serializable data class ServerAddresses(val home: String? = null, val away: String? = null)

/** The capability flags the watch reads (`GET /api/v1/server`). Absent means an older server. */
@Serializable
data class ServerCapabilities(
  val listeningSync: Boolean? = null,
  val renditions: Boolean? = null,
  val coverSizes: Boolean? = null,
  val addresses: Boolean? = null,
)

@Serializable
data class ServerInfo(
  val name: String? = null,
  val serverId: String? = null,
  val version: String? = null,
  val capabilities: ServerCapabilities? = null,
  /** The rendition kinds the server makes (`["watch"]`). Absent on servers before 2.6. */
  val renditions: List<String>? = null,
) {
  /**
   * Decision 5: the watch app needs Sync v2 (`listening_sync`) and the watch rendition. No
   * `PUT .../progress` fallback on the watch: an older server gets the "too old" screen.
   */
  val supportsWatch: Boolean
    get() = capabilities?.listeningSync == true && (renditions ?: emptyList()).contains("watch")
}

@Serializable data class WireUser(val id: Int, val username: String, val displayName: String? = null)

/** `POST /auth/exchange` answer. */
@Serializable
data class AuthSession(
  val token: String,
  val serverId: String,
  val user: WireUser,
  val addresses: ServerAddresses? = null,
)

/** A server error body: `{"error": msg, "code": code}`. */
@Serializable data class APIErrorBody(val error: String? = null, val code: String? = null)

/**
 * A server's own answer that was not a success (any status outside 2xx). Anything else a request
 * throws (an `IOException`) means no server answered: offline, for the outbox's rules.
 */
data class APIError(
  val status: Int,
  val code: String? = null,
  override val message: String? = null,
  /** `Retry-After` in seconds, when the answer carried one. */
  val retryAfter: Double? = null,
) : Exception("HTTP $status${code?.let { " $it" } ?: ""}") {
  companion object {
    /** The longest wait a `Retry-After` is taken for: any longer is this long. */
    const val MAX_RETRY_AFTER: Double = 3600.0

    /** A refused answer: its status, its JSON error body (when it parses) and its `Retry-After`. */
    fun of(status: Int, body: String?, retryAfterHeader: String?): APIError {
      val parsed =
        body?.let {
          try {
            Wire.json.decodeFromString(APIErrorBody.serializer(), it)
          } catch (_: Exception) {
            null
          }
        }
      return APIError(status, parsed?.code, parsed?.error, retryAfterHeader?.let(::retryAfterSeconds))
    }

    /**
     * A `Retry-After` header in seconds when it reads as a finite, non-negative number (the
     * phone's rule: a date or anything else reads as none), at most `MAX_RETRY_AFTER`.
     */
    fun retryAfterSeconds(header: String): Double? {
      val n = header.trim().toDoubleOrNull() ?: return null
      if (!n.isFinite() || n < 0) return null
      return min(n, MAX_RETRY_AFTER)
    }
  }
}

// Books

@Serializable
data class BookFile(
  val relPath: String,
  val seq: Int,
  val duration: Double,
  val format: String? = null,
  val size: Long,
)

@Serializable
data class Chapter(
  val index: Int,
  val title: String,
  val fileIndex: Int,
  val filePath: String,
  val start: Double,
  val end: Double,
  val bookOffset: Double,
)

/** `GET /libraries/{id}/item` (the fields the watch uses). */
@Serializable
data class Book(
  val libraryId: Int? = null,
  val relPath: String,
  val title: String,
  val author: String? = null,
  val narrator: String? = null,
  val duration: Double,
  val size: Long? = null,
  val files: List<BookFile>? = null,
  val chapters: List<Chapter>? = null,
)

/** `GET /libraries/{id}/chapters`. */
@Serializable
data class ChaptersResponse(
  val duration: Double? = null,
  val files: List<BookFile>? = null,
  val chapters: List<Chapter>? = null,
)

// Progress (Sync v2)

/** A place the server did not keep (the losing side of a diverged event). */
@Serializable
data class OtherPlace(
  val position: Double,
  val deviceId: String,
  val deviceName: String? = null,
  val updatedAt: String,
)

/** A book's progress row (`Progress` in types.ts). */
@Serializable
data class ProgressRow(
  val libraryId: Int,
  val path: String,
  val position: Double,
  val duration: Double,
  val finished: Boolean,
  val playbackSpeed: Double? = null,
  val version: Int,
  val deviceId: String? = null,
  val updatedAt: String,
  val startedAt: String? = null,
  val finishedAt: String? = null,
  val deviceName: String? = null,
  val otherPlace: OtherPlace? = null,
) {
  val ref: BookRef
    get() = BookRef(libraryId, path)
}

/** `GET /me/progress`. */
@Serializable data class ProgressList(val progress: List<ProgressRow>? = null)

/** A book by its identity (CROSS-REPO section 1: path is the identity, never a DB id). */
@Serializable
data class BookRef(val libraryId: Int, val path: String) {
  /** One string per book, for file names and map keys. */
  val key: String
    get() = "$libraryId\u0000$path"
}

// Listening events (Sync v2, `POST /me/listening/sync`)

/** Why a span began. */
@Serializable
enum class ListeningStart {
  @SerialName("resume") RESUME,
  @SerialName("continue") CONTINUE,
  @SerialName("moved_back") MOVED_BACK,
  @SerialName("jump") JUMP,
  @SerialName("restart") RESTART,
}

/** A listening event: a span (`listen`) or a `finish` / `unfinish`. */
@Serializable(with = ListeningEventSerializer::class)
sealed interface ListeningEvent {
  val id: String
  val kind: String
  val libraryId: Int
  val path: String
  val baseVersion: Int?

  val ref: BookRef
    get() = BookRef(libraryId, path)

  /** When it happened: a span's end, a finish's `at`. */
  val time: Instant?

  /**
   * Whether every number it carries is finite: one that is not is never enqueued (JSON has no
   * NaN). `eventIsFinite` in listening-outbox.ts.
   */
  val isFinite: Boolean
}

/**
 * A span of listening: whole-book seconds on this device's timeline, each end's audio file (rel
 * path) and seconds in it (both of a pair or neither), the device's length of the book, the speed
 * (absent = 1), the wall times (RFC 3339, device clock), why it began, and the version this device
 * had acknowledged (`base_version`).
 */
@Serializable
data class SpanEvent(
  override val id: String,
  override val kind: String = "listen",
  override val libraryId: Int,
  override val path: String,
  val fromPos: Double,
  val toPos: Double,
  val fromFile: String? = null,
  val fromFilePos: Double? = null,
  val toFile: String? = null,
  val toFilePos: Double? = null,
  val duration: Double? = null,
  val playbackSpeed: Double? = null,
  val startedAt: String,
  val endedAt: String,
  val start: ListeningStart,
  override val baseVersion: Int? = null,
) : ListeningEvent {
  override val time: Instant?
    get() = ISOTime.parse(endedAt)

  override val isFinite: Boolean
    get() =
      listOf(fromPos, toPos, fromFilePos, toFilePos, duration, playbackSpeed).all {
        it?.isFinite() ?: true
      }
}

/** Marking a book finished (`finish`) or not (`unfinish`) at `at`. */
@Serializable
data class FinishEvent(
  override val id: String,
  override val kind: String,
  override val libraryId: Int,
  override val path: String,
  val at: String,
  override val baseVersion: Int? = null,
) : ListeningEvent {
  override val time: Instant?
    get() = ISOTime.parse(at)

  override val isFinite: Boolean
    get() = true
}

/** A `listen` reads as a span, anything else as a finish, by its `kind`. */
object ListeningEventSerializer : KSerializer<ListeningEvent> {
  @OptIn(ExperimentalSerializationApi::class)
  override val descriptor: SerialDescriptor =
    SerialDescriptor("app.audiosilo.ListeningEvent", JsonObject.serializer().descriptor)

  override fun serialize(encoder: Encoder, value: ListeningEvent) =
    when (value) {
      is SpanEvent -> encoder.encodeSerializableValue(SpanEvent.serializer(), value)
      is FinishEvent -> encoder.encodeSerializableValue(FinishEvent.serializer(), value)
    }

  override fun deserialize(decoder: Decoder): ListeningEvent {
    val input = decoder as? JsonDecoder ?: error("ListeningEvent reads only from JSON")
    val element = input.decodeJsonElement()
    val kind = element.jsonObject["kind"]?.jsonPrimitive?.content
    return if (kind == "listen") {
      input.json.decodeFromJsonElement(SpanEvent.serializer(), element)
    } else {
      input.json.decodeFromJsonElement(FinishEvent.serializer(), element)
    }
  }
}

/**
 * The batch envelope: exactly one of `sent_at` (this attempt's device clock) and `clock_offset`
 * (seconds, server minus device). The Wear watch builds each body as it sends (decision 9), so it
 * always carries `sent_at`; `clock_offset` is mirrored for the wire's sake.
 */
@Serializable
data class SyncRequest(
  val deviceId: String,
  val sentAt: String? = null,
  val clockOffset: Double? = null,
  val events: List<ListeningEvent>,
)

@Serializable
data class SyncResult(
  val id: String,
  /** applied | duplicate | diverged | not_applied | rejected */
  val status: String,
  val reason: String? = null,
  /** diverged: event | stored */
  val kept: String? = null,
  val otherPlace: OtherPlace? = null,
)

@Serializable
data class SyncResponse(
  val serverTime: String? = null,
  val results: List<SyncResult>? = null,
  val progress: List<ProgressRow>? = null,
)

// Renditions (Track W2)

/** One audio file's watch rendition: `path` is the original file (as `/stream` takes it). */
@Serializable
data class RenditionFile(
  val path: String,
  /** ready | pending | failed | missing */
  val state: String,
  val bytes: Long? = null,
  val retryAfterSeconds: Double? = null,
)

/** `POST`/`GET /libraries/{id}/renditions`. */
@Serializable data class RenditionsAnswer(val kind: String? = null, val files: List<RenditionFile>)
