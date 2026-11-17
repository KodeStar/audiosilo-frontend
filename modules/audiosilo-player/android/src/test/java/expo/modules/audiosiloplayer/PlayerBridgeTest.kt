package expo.modules.audiosiloplayer

import org.junit.After
import org.junit.Assert.assertEquals
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
}
