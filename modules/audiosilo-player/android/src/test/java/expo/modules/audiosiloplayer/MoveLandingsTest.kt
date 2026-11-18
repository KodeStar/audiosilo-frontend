package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
  private val target = MoveLandings.Target(2, 40_000)
  /** The controller's place once a move's call returned, far from [target]. */
  private val elsewhere = { MoveLandings.Target(0, 0) }

  @Test
  fun aMaskedSeekResolvesInsideItsCallAfterItsSample() {
    val log = mutableListOf<String>()
    landings.run({ log.add("taken $it") }, elsewhere) {
      // The controller's masked seek tells its discontinuity inside the call, even at a place
      // other than the asked one (clamped to a short measure).
      log.add("progress")
      landings.landed(2, 29_889)
      target
    }
    assertEquals(listOf("progress", "taken true"), log)
    assertTrue(clock.posted.isEmpty())
  }

  @Test
  fun aMoveReportedAfterItsCallResolvesAtItsTarget() {
    val taken = mutableListOf<Boolean>()
    landings.run({ taken.add(it) }, elsewhere) { target }
    assertEquals(emptyList<Boolean>(), taken)
    landings.landed(2, 40_020)
    assertEquals(listOf(true), taken)
    // The fallback was called off: nothing settles twice.
    clock.fire()
    assertEquals(listOf(true), taken)
  }

  @Test
  fun aLockScreenSeekWhileAMoveWaitsIsNotItsLanding() {
    val taken = mutableListOf<Boolean>()
    landings.run({ taken.add(it) }, elsewhere) { target }
    landings.landed(2, 90_000) // the lock screen's scrub, another place
    landings.landed(3, 40_000) // the car's next, another item
    assertEquals(emptyList<Boolean>(), taken)
    clock.fire()
    assertEquals(listOf(false), taken)
  }

  @Test
  fun aMoveTheControllerNeverReportsIsNotTakenAfterTheFallback() {
    val taken = mutableListOf<Boolean>()
    assertNull(landings.run({ taken.add(it) }, elsewhere) { target })
    assertEquals(listOf(MoveLandings.FALLBACK_MS), clock.posted.map { it.second })
    clock.fire()
    assertEquals(listOf(false), taken)
  }

  @Test
  fun aMoveThatLandsInItsCallTakesTheEarlierOnesStillWaiting() {
    val first = mutableListOf<Boolean>()
    val second = mutableListOf<Boolean>()
    landings.run({ first.add(it) }, elsewhere) { target }
    landings.run({ second.add(it) }, elsewhere) {
      landings.landed(2, 10_000)
      MoveLandings.Target(2, 10_000)
    }
    assertEquals(listOf(true), first)
    assertEquals(listOf(true), second)
    assertTrue(clock.posted.isEmpty())
  }

  @Test
  fun aDiscontinuityWithNoMoveWaitingSettlesNothing() {
    landings.landed(2, 40_000)
    val taken = mutableListOf<Boolean>()
    landings.run({ taken.add(it) }, elsewhere) { target }
    assertEquals(emptyList<Boolean>(), taken)
    landings.landed(2, 40_000)
    assertEquals(listOf(true), taken)
  }

  @Test
  fun aMoveThatThrowsIsNotTakenAndItsThrowIsReturnedNotRethrown() {
    val taken = mutableListOf<Boolean>()
    // Rethrown, it would crash the app from the main thread's post.
    val failed = landings.run({ taken.add(it) }, elsewhere) {
      throw IllegalStateException("bad seek")
    }
    assertEquals("bad seek", failed?.message)
    assertEquals(listOf(false), taken)
    assertTrue(clock.posted.isEmpty())
    // The next move is told apart from it.
    landings.run({ taken.add(it) }, elsewhere) {
      landings.landed(2, 40_000)
      target
    }
    assertEquals(listOf(false, true), taken)
  }

  @Test
  fun aMoveToWhereTheEngineIsIsTakenWithNoDiscontinuity() {
    // Tapping the chapter it is in: Media3 may report nothing for a seek that goes nowhere.
    val taken = mutableListOf<Boolean>()
    landings.run({ taken.add(it) }, { MoveLandings.Target(2, 40_180) }) { target }
    assertEquals(listOf(true), taken)
    assertTrue(clock.posted.isEmpty())
  }

  @Test
  fun aMoveNotTakenNearItsTargetInAnotherItemStillWaits() {
    val taken = mutableListOf<Boolean>()
    landings.run({ taken.add(it) }, { MoveLandings.Target(1, 40_000) }) { target }
    assertEquals(emptyList<Boolean>(), taken)
    clock.fire()
    assertEquals(listOf(false), taken)
  }
}
