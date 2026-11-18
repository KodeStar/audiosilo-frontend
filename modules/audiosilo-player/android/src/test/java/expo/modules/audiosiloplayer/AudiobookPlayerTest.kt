package expo.modules.audiosiloplayer

import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** fe#157: a failed engine reads as stopped, never as a fatal error, so Android Auto keeps its
 * play button (the device run: the car showed the error with no controls, and only a hardware
 * play key started the book again). */
class AudiobookPlayerTest {
  /** The engine's side of the wrapper: just the state it reports and what was asked of it. */
  private class Engine {
    var state = Player.STATE_READY
    var error: PlaybackException? = null
    var items = 1
    val calls = ArrayList<String>()

    val player: Player = Proxy.newProxyInstance(
      Player::class.java.classLoader,
      arrayOf(Player::class.java),
    ) { _, method, _ ->
      when (method.name) {
        "getPlaybackState" -> state
        "getPlayerError" -> error
        "getMediaItemCount" -> items
        "prepare" -> {
          calls.add("prepare")
          state = Player.STATE_BUFFERING
          error = null
          Unit
        }
        else -> throw UnsupportedOperationException(method.name)
      }
    } as Player
  }

  private object Hooks : AudiobookPlayerHooks {
    override fun isRemoteRequest() = false
    override fun onRemoteMove() = Unit
    override fun onRemoteRate(rate: Float) = Unit
  }

  /** A PlaybackException without its constructor, which reads Android's clock (not on the JVM). */
  private fun anError(): PlaybackException {
    val unsafeClass = Class.forName("sun.misc.Unsafe")
    val field = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }
    val allocate = unsafeClass.getMethod("allocateInstance", Class::class.java)
    return allocate.invoke(field.get(null), PlaybackException::class.java) as PlaybackException
  }

  @Test fun aFailedEngineReadsAsReadyWithNoError() {
    val engine = Engine().apply {
      state = Player.STATE_IDLE
      error = anError()
    }
    val player = AudiobookPlayer(engine.player, Hooks)
    assertTrue(player.failed)
    assertEquals(Player.STATE_READY, player.playbackState)
    assertNull(player.playerError)
  }

  @Test fun aPlayPreparesTheFailedEngineAgainFirst() {
    val engine = Engine().apply {
      state = Player.STATE_IDLE
      error = anError()
    }
    val player = AudiobookPlayer(engine.player, Hooks)
    assertTrue(player.prepareIfFailed())
    assertEquals(listOf("prepare"), engine.calls)
    assertFalse(player.failed)
    // Prepared, it reads as the engine does again.
    assertEquals(Player.STATE_BUFFERING, player.playbackState)
  }

  @Test fun anEngineThatHasNotFailedReadsAsItIs() {
    val engine = Engine()
    val player = AudiobookPlayer(engine.player, Hooks)
    for (state in listOf(Player.STATE_IDLE, Player.STATE_BUFFERING, Player.STATE_READY, Player.STATE_ENDED)) {
      engine.state = state
      assertFalse(player.failed)
      assertEquals(state, player.playbackState)
      assertFalse(player.prepareIfFailed())
    }
    assertTrue(engine.calls.isEmpty())
  }

  // Idle with nothing loaded is not a book to start again: Media3's resumption answers a play.
  @Test fun anEmptyEngineIsNeverReadAsFailed() {
    val error = anError()
    val engine = Engine().apply {
      state = Player.STATE_IDLE
      this.error = error
      items = 0
    }
    val player = AudiobookPlayer(engine.player, Hooks)
    assertFalse(player.failed)
    assertEquals(Player.STATE_IDLE, player.playbackState)
    assertSame(error, player.playerError)
  }
}
