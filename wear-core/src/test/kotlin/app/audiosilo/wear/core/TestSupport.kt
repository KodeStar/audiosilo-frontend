// The Swift suites' shared fixtures (OutboxTests.swift, SpanRecorderTests.swift), ported.
package app.audiosilo.wear.core

import java.io.File
import java.nio.file.Files
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.yield

const val DEVICE_ID = "watch-device"

class TestClock(iso: String = "2026-10-25T07:00:00.000Z") {
  var now: Instant = ISOTime.parse(iso)!!

  fun advance(seconds: Double) {
    now = now.addingSeconds(seconds)
  }
}

class MemorySpanStore : OpenSpanStore {
  var stored: OpenSpan? = null
  val saves = ArrayList<OpenSpan?>()

  override fun load(): OpenSpan? = stored

  override fun save(span: OpenSpan?) {
    stored = span
    saves += span
  }
}

/** A fresh temp directory, removed by the caller. */
fun tempDir(): File = Files.createTempDirectory("wear-core").toFile()

fun iso(s: String): Instant = ISOTime.parse(s)!!

fun listen(
  id: String,
  endedAt: String = "2026-10-25T07:33:30.000Z",
  lib: Int = 3,
  path: String = "Author/Book",
): ListeningEvent =
  SpanEvent(
    id = id,
    libraryId = lib,
    path = path,
    fromPos = 14400.0,
    toPos = 16800.0,
    duration = 61200.0,
    startedAt = "2026-10-25T07:00:12.000Z",
    endedAt = endedAt,
    start = ListeningStart.RESUME,
    baseVersion = 41,
  )

class NoAnswer : Exception("no answer")

fun answer(
  body: SyncRequest,
  serverTime: String = "2026-10-25T07:41:03.480Z",
  status: (ListeningEvent) -> SyncResult? = { null },
  progress: List<ProgressRow> = emptyList(),
) =
  SyncResponse(
    serverTime = serverTime,
    results = body.events.map { status(it) ?: SyncResult(it.id, "applied") },
    progress = progress,
  )

fun row(lib: Int = 3, path: String = "Author/Book", version: Int, device: String? = DEVICE_ID) =
  ProgressRow(
    libraryId = lib,
    path = path,
    position = 16800.0,
    duration = 61200.0,
    finished = false,
    playbackSpeed = 1.0,
    version = version,
    deviceId = device,
    updatedAt = "2026-10-25T07:33:30.000Z",
  )

/** A transport that answers with `respond` and records every body it was sent. */
class FakeTransport(var respond: suspend (SyncRequest) -> SyncResponse = { answer(it) }) :
  ListeningSyncTransport {
  val bodies = ArrayList<SyncRequest>()

  override suspend fun syncListening(request: SyncRequest): SyncResponse {
    bodies += request
    return respond(request)
  }
}

/** A transport that holds each request until the test lets it go. */
class HeldTransport : ListeningSyncTransport {
  val bodies = ArrayList<SyncRequest>()
  private val held = ArrayList<CompletableDeferred<SyncResponse>>()

  override suspend fun syncListening(request: SyncRequest): SyncResponse {
    bodies += request
    val d = CompletableDeferred<SyncResponse>()
    held += d
    return d.await()
  }

  /** Until a request has come in. */
  suspend fun requestArrives() {
    while (held.isEmpty()) yield()
  }

  fun reply(r: SyncResponse) {
    held.removeAt(0).complete(r)
  }

  fun refuse(e: Throwable) {
    held.removeAt(0).completeExceptionally(e)
  }
}
