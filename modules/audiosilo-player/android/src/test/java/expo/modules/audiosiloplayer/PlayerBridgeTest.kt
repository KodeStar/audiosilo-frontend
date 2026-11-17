package expo.modules.audiosiloplayer

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayerBridgeTest {
  private class Sink(override val observingCar: Boolean) : PlayerEventSink {
    val requests = ArrayList<String>()
    val cancels = ArrayList<String>()
    override fun remoteMove(fileIndex: Int, position: Double) = Unit
    override fun rateChange(rate: Double) = Unit
    override fun remoteBookmark(fileIndex: Int, position: Double, book: BookRef?, relPath: String?) = Unit
    override fun carConnection(connected: Boolean) = Unit
    override fun carPlayRequest(id: String) { requests.add(id) }
    override fun carPlayCancel(id: String) { cancels.add(id) }
    override val observingBookmarks = false
  }

  @After fun reset() {
    PlayerBridge.sink = null
    PlayerBridge.pendingCarPlayId = null
  }

  // FE-13: a play JS received and was still starting (a frozen server) when the service's wait
  // ran out: JS is told, so the late start never plays out of the foreground.
  @Test fun aDeliveredPlayIsCalledOffInJs() {
    val sink = Sink(observingCar = true)
    PlayerBridge.sink = sink
    PlayerBridge.requestCarPlay("book:A")
    PlayerBridge.cancelCarPlay("book:A")
    assertEquals(listOf("book:A"), sink.requests)
    assertEquals(listOf("book:A"), sink.cancels)
  }

  // Never delivered (JS not listening yet): dropped here, so a JS that listens later never
  // starts it, and is told nothing.
  @Test fun anUndeliveredPlayIsDroppedQuietly() {
    val sink = Sink(observingCar = false)
    PlayerBridge.sink = sink
    PlayerBridge.requestCarPlay("book:A")
    assertEquals("book:A", PlayerBridge.pendingCarPlayId)
    PlayerBridge.cancelCarPlay("book:A")
    assertNull(PlayerBridge.pendingCarPlayId)
    assertTrue(sink.cancels.isEmpty())
  }

  // A tap on A, then one on B while JS was past stopping A: A's late load (paused in JS) is not
  // B's, which waits for its own.
  @Test fun theLateLoadOfACalledOffPlayNeverCompletesTheOneThatReplacedIt() {
    val a = BookRef("s.u", 2, "A")
    val b = BookRef("s.u", 2, "B")
    assertFalse(PlayerBridge.completesCarPlay(loaded = a, pending = b, calledOff = a))
    assertTrue(PlayerBridge.completesCarPlay(loaded = b, pending = b, calledOff = a))
    // The same book asked for again after its wait ran out: its load is the one waited for.
    assertTrue(PlayerBridge.completesCarPlay(loaded = a, pending = a, calledOff = a))
    // Any other load completes it as it always did (the app's own start of another book; a
    // path the server resolved to its folder book), a book never named included.
    assertTrue(PlayerBridge.completesCarPlay(loaded = BookRef("s.u", 2, "C"), pending = b, calledOff = a))
    assertTrue(PlayerBridge.completesCarPlay(loaded = a, pending = b, calledOff = null))
    assertTrue(PlayerBridge.completesCarPlay(loaded = null, pending = b, calledOff = a))
    assertTrue(PlayerBridge.completesCarPlay(loaded = b, pending = null, calledOff = a))
  }
}
