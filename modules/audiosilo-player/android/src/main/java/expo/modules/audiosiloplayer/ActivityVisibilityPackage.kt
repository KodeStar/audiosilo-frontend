package expo.modules.audiosiloplayer

import android.app.Activity
import android.content.Context
import android.os.Bundle
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.CopyOnWriteArraySet

/** Track React activities from creation, including starts before JS exists. Pausing
 * behind a dialog or in split screen leaves the activity visible until onStop. */
internal class StartedActivities : DefaultLifecycleObserver {
  private var started = 0
  @Volatile var visible = false
    private set
  val listeners = CopyOnWriteArraySet<() -> Unit>()

  override fun onStart(owner: LifecycleOwner) = update(1)
  override fun onStop(owner: LifecycleOwner) = update(-1)

  private fun update(delta: Int) {
    started += delta
    val next = started > 0
    if (visible == next) return
    visible = next
    listeners.forEach { it() }
  }
}

private val activities = StartedActivities()

class ActivityVisibilityPackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context) =
    listOf(object : ReactActivityLifecycleListener {
      override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
        (activity as LifecycleOwner).lifecycle.addObserver(activities)
      }
    })
}

/** Independent of the player module so observing visibility never attaches a JS player. */
class ActivityVisibilityModule : Module() {
  private val changed = { sendEvent("onVisibilityChange", emptyMap<String, Any?>()) }

  override fun definition() = ModuleDefinition {
    Name("AudiosiloActivityVisibility")
    Events("onVisibilityChange")
    Function("isVisible") { activities.visible }
    OnStartObserving("onVisibilityChange") {
      activities.listeners.add(changed)
      changed()
    }
    OnStopObserving("onVisibilityChange") { activities.listeners.remove(changed) }
    OnDestroy { activities.listeners.remove(changed) }
  }
}
