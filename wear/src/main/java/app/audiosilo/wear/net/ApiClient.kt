// The Wear app's server client (the twin of targets/watch/Net/APIClient.swift): `Authorization:
// Bearer` (never `?token=`), the identity header `X-AudioSilo-Client: audiosilo-watch/<version>
// (wearos)` on every request (decision 11), JSON through `Wire`. No connectivity gate (decision
// 3): every call is tried, and an `IOException` (no answer) is what offline means. A server's own
// non-2xx answer throws `APIError`.
package app.audiosilo.wear.net

import app.audiosilo.wear.BuildConfig
import app.audiosilo.wear.core.APIError
import app.audiosilo.wear.core.AddressPicker
import app.audiosilo.wear.core.AuthSession
import app.audiosilo.wear.core.Book
import app.audiosilo.wear.core.BookRef
import app.audiosilo.wear.core.BookServer
import app.audiosilo.wear.core.ChaptersResponse
import app.audiosilo.wear.core.ClientHeader
import app.audiosilo.wear.core.Fetched
import app.audiosilo.wear.core.ListeningSyncTransport
import app.audiosilo.wear.core.ProgressList
import app.audiosilo.wear.core.ProgressRow
import app.audiosilo.wear.core.QueryString
import app.audiosilo.wear.core.RenditionPlan
import app.audiosilo.wear.core.RenditionsAnswer
import app.audiosilo.wear.core.ServerAddresses
import app.audiosilo.wear.core.ServerInfo
import app.audiosilo.wear.core.SyncRequest
import app.audiosilo.wear.core.SyncResponse
import app.audiosilo.wear.core.Wire
import app.audiosilo.wear.core.orNull
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

class ApiClient(base: String, private val token: String?, private val http: OkHttpClient = shared) :
  BookServer, ListeningSyncTransport {
  val base: String = AddressPicker.trimSlashes(base)

  fun url(path: String, query: Map<String, String> = emptyMap()): HttpUrl? {
    // Encoded by hand: a raw `;` or `+` in a book path would not read back (QueryString).
    val q = if (query.isEmpty()) "" else "?" + QueryString.encode(query)
    return "$base/api/v1$path$q".toHttpUrlOrNull()
  }

  /** A request with the identity header and, when signed in, the bearer token. */
  fun request(method: String, path: String, query: Map<String, String> = emptyMap(), body: String? = null): Request {
    val u = url(path, query) ?: throw IOException("not a URL: $base$path")
    val b = Request.Builder().url(u).header(ClientHeader.NAME, ClientHeader.value(APP_VERSION)).header("Accept", "application/json")
    token?.let { b.header("Authorization", "Bearer $it") }
    b.method(method, body?.toRequestBody(JSON))
    return b.build()
  }

  /**
   * The answer's body when it is a success; else the server's answer as an `APIError`. The body is
   * read off the caller's thread: the model calls from the main thread, where a body still on the
   * wire must not be read.
   */
  private suspend fun execute(r: Request, timeout: Double): String =
    withContext(Dispatchers.IO) {
      val call = http.newCall(r)
      call.timeout().timeout((timeout * 1000).toLong(), TimeUnit.MILLISECONDS)
      call.await().use { resp ->
        val text = resp.body?.string()
        check(resp, text)
        text ?: ""
      }
    }

  private suspend fun <T> send(r: Request, serializer: KSerializer<T>, timeout: Double = TIMEOUT): T =
    withContext(Dispatchers.IO) { Wire.json.decodeFromString(serializer, execute(r, timeout)) }

  // Routes

  suspend fun serverInfo(timeout: Double = TIMEOUT): ServerInfo = send(request("GET", "/server"), ServerInfo.serializer(), timeout)

  suspend fun exchange(pairingToken: String, deviceName: String): AuthSession {
    val body = buildJsonObject {
      put("pairing_token", pairingToken)
      put("device_name", deviceName)
    }
    return send(request("POST", "/auth/exchange", body = body.toString()), AuthSession.serializer())
  }

  /** `GET /addresses`: the server's addresses as seen from here (capability `addresses`). */
  suspend fun addresses(): ServerAddresses = send(request("GET", "/addresses"), ServerAddresses.serializer())

  suspend fun allProgress(): List<ProgressRow> = send(request("GET", "/me/progress"), ProgressList.serializer()).progress ?: emptyList()

  /** `{"progress": row}`, or `{"progress": null}` when the server has no place for the book. */
  override suspend fun progress(ref: BookRef): ProgressRow? {
    val one = send(request("GET", "/libraries/${ref.libraryId}/progress", mapOf("path" to ref.path)), JsonObject.serializer())
    val row = one["progress"]
    return if (row == null || row is JsonNull) null else Wire.json.decodeFromJsonElement(ProgressRow.serializer(), row)
  }

  override suspend fun item(ref: BookRef): Book =
    send(request("GET", "/libraries/${ref.libraryId}/item", mapOf("path" to ref.path)), Book.serializer(), UPSTREAM_TIMEOUT)

  override suspend fun chapters(ref: BookRef): ChaptersResponse =
    send(request("GET", "/libraries/${ref.libraryId}/chapters", mapOf("path" to ref.path)), ChaptersResponse.serializer(), UPSTREAM_TIMEOUT)

  /** `POST .../renditions {"kind":"watch"}`: queue every file of the book (202). */
  override suspend fun prepareRenditions(ref: BookRef): RenditionsAnswer =
    send(
      request("POST", "/libraries/${ref.libraryId}/renditions", mapOf("path" to ref.path), """{"kind":"watch"}"""),
      RenditionsAnswer.serializer(),
    )

  /** `GET .../renditions?kind=watch`: where each file stands, queueing nothing. */
  override suspend fun renditionStatus(ref: BookRef): RenditionsAnswer =
    send(request("GET", "/libraries/${ref.libraryId}/renditions", mapOf("path" to ref.path, "kind" to "watch")), RenditionsAnswer.serializer())

  /**
   * A file's watch rendition as a download (Bearer, `?rendition=watch&download=1`), from byte
   * `from` with `If-Range` when resuming. No overall time limit: a stall is the read timeout.
   */
  override suspend fun download(libraryId: Int, file: String, from: Long, ifRange: String?): Fetched {
    val b = request("GET", "/libraries/$libraryId/stream", mapOf("path" to file, "rendition" to "watch", "download" to "1")).newBuilder()
    if (from > 0) {
      b.header("Range", "bytes=$from-")
      ifRange?.let { b.header("If-Range", it) }
    }
    val resp = http.newCall(b.build()).await()
    if (RenditionPlan.downloadSucceeded(resp.code)) {
      val body = resp.body ?: run {
        resp.close()
        throw IOException("no body")
      }
      return Fetched(resp.code, resp.header("ETag"), body.byteStream())
    }
    resp.use { check(it, it.body?.string()) }
    throw IOException("unexpected ${resp.code}")
  }

  /** `POST /auth/logout`: end this watch's token on the server (sign-out, or a replaced account). */
  suspend fun logout() {
    execute(request("POST", "/auth/logout", body = "{}"), PROBE_TIMEOUT * 2)
  }

  /** `POST /me/listening/sync`, the outbox's transport (a fresh `sent_at` per attempt). */
  override suspend fun syncListening(request: SyncRequest): SyncResponse =
    send(
      request("POST", "/me/listening/sync", body = Wire.json.encodeToString(SyncRequest.serializer(), request)),
      SyncResponse.serializer(),
    )

  companion object {
    /** The ordinary request budget (seconds). */
    const val TIMEOUT = 20.0

    /** An unscanned book folder is indexed on demand by `/item` and `/chapters` (fe#154). */
    const val UPSTREAM_TIMEOUT = 30.0

    /** How long a home address gets to answer the tokenless probe. */
    const val PROBE_TIMEOUT = 2.5

    /** This build's version (`versionName`, the phone app's). */
    val APP_VERSION: String = BuildConfig.VERSION_NAME ?: "0"

    private val JSON = "application/json".toMediaType()

    /** One connection pool for the app; a book's worker binds a copy to its network. */
    val shared: OkHttpClient =
      OkHttpClient.Builder()
        .connectTimeout(TIMEOUT.toLong(), TimeUnit.SECONDS)
        .readTimeout(TIMEOUT.toLong(), TimeUnit.SECONDS)
        .writeTimeout(TIMEOUT.toLong(), TimeUnit.SECONDS)
        .cache(null)
        .build()

    /** Throw the server's answer as an `APIError` unless it is a success. */
    fun check(resp: Response, body: String?) {
      if (resp.isSuccessful) return
      throw APIError.of(resp.code, body, resp.header("Retry-After"))
    }

    /** Ask `url` who it is with NO token: its `server_id`, else null. Never throws but a cancel. */
    suspend fun probeServerId(url: String, http: OkHttpClient = shared): String? =
      orNull { ApiClient(url, null, http).serverInfo(PROBE_TIMEOUT).serverId }

    /** Whether an error means the request timed out (no fallback to a home address after one). */
    fun isTimeout(e: Throwable): Boolean =
      e is SocketTimeoutException || (e is InterruptedIOException && e.message == "timeout")
  }
}

/** Run a call without blocking a thread; a cancelled coroutine cancels the call. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
  cont.invokeOnCancellation { cancel() }
  enqueue(
    object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        if (cont.isActive) cont.resumeWithException(e)
      }

      override fun onResponse(call: Call, response: Response) {
        cont.resume(response) { _, value, _ -> value.close() }
      }
    }
  )
}
