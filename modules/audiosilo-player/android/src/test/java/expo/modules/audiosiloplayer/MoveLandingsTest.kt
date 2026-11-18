package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MoveLandingsTest {
  /** A main-thread handler that runs its posts only when told. */
  private class Clock {
    val posted = mutableListOf<Pair<Runnable, Long>>()
    fun schedule(r: Runnable, ms: Long) {
      posted.add(r to ms)
    }
    fun cancel(r: Runnable) {
      posted.removeAll { it.first === r }
    }
    fun fire() {
      val due = posted.toList()
      posted.clear()
      due.forEach { it.first.run() }
    }
  }

  private val clock = Clock()
  private val landings = MoveLandings(clock::schedule, clock::cancel)

  @Test
  fun aMaskedSeekResolvesInsideItsCallAfterItsSample() {
    val log = mutableListOf<String>()
    landings.run({ log.add("resolved") }) {
      // The controller's masked seek tells its discontinuity inside the call.
      log.add("progress")
      landings.landed()
    }
    assertEquals(listOf("progress", "resolved"), log)
    assertTrue(clock.posted.isEmpty())
  }

  @Test
  fun aMoveWaitsForTheControllersReportOfTheNewPlace() {
    var resolved = 0
    landings.run({ resolved++ }) { /* the discontinuity comes later */ }
    assertEquals(0, resolved)
    landings.landed()
    assertEquals(1, resolved)
    // The fallback was called off: nothing resolves twice.
    clock.fire()
    assertEquals(1, resolved)
  }

  @Test
  fun aMoveTheControllerNeverReportsResolvesAfterTheFallback() {
    var resolved = 0
    landings.run({ resolved++ }) {}
    assertEquals(listOf(MoveLandings.FALLBACK_MS), clock.posted.map { it.second })
    clock.fire()
    assertEquals(1, resolved)
  }

  @Test
  fun aDiscontinuityWithNoMoveWaitingResolvesNothing() {
    landings.landed()
    var resolved = 0
    landings.run({ resolved++ }) {}
    assertEquals(0, resolved)
    landings.landed()
    assertEquals(1, resolved)
  }

  @Test
  fun aMoveThatThrowsStillResolves() {
    var resolved = 0
    try {
      landings.run({ resolved++ }) { throw IllegalStateException("no controller") }
    } catch (_: IllegalStateException) {
    }
    assertEquals(1, resolved)
    assertTrue(clock.posted.isEmpty())
  }
}
