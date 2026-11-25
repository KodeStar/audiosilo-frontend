package expo.modules.audiosiloplayer

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import org.junit.Assert.assertEquals
import org.junit.Test

class StartedActivitiesTest {
  private fun activity() = object : LifecycleOwner {
    override val lifecycle: Lifecycle get() = error("unused")
  }

  @Test fun aPausedOrOverlappingActivityStaysVisibleUntilTheLastStop() {
    val state = StartedActivities()
    val seen = mutableListOf(state.visible)
    state.listeners.add { seen.add(state.visible) }
    val first = activity()
    val second = activity()
    state.onStart(first)
    state.onPause(first)
    state.onStart(second)
    state.onStop(first)
    state.onStop(second)
    assertEquals(listOf(false, true, false), seen)
  }
}
