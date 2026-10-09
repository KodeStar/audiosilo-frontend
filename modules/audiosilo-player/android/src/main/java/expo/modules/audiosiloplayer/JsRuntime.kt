package expo.modules.audiosiloplayer

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

/**
 * Boots the app's JS without an activity when the service needs it: a car play JS must start (a
 * book that is not downloaded), a book the service started that must save its progress, a
 * bookmark pressed while no JS ran, Android Auto connecting (JS refreshes the car snapshot).
 *
 * In-process, NOT a `HeadlessJsTaskService`: Android 12+ forbids starting a service from the
 * background, and we already run inside the media service. Mirrors what RN 0.85's
 * `HeadlessJsTaskService.createReactContextAndScheduleTask` does in bridgeless mode (and expo's
 * `RNHeadlessAppLoader`): `ReactHost.start()` on the main thread, then
 * `HeadlessJsTaskContext.startTask` once the context is up. The task is `AudiosiloCar`, which the
 * JS entry (`index.ts`) registers; it runs the same launch steps the root layout runs and then
 * the car controller. A later activity on the same runtime adopts the already started host.
 */
object JsRuntime {
  private const val TAG = "AudiosiloCar"
  const val TASK = "AudiosiloCar"

  private val main = Handler(Looper.getMainLooper())
  private var starting = false
  private var taskId: Int? = null
  private var taskContext: ReactContext? = null

  /** Make sure the JS car controller runs, inside a running task. Main thread. */
  fun ensure(context: Context) {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      main.post { ensure(context) }
      return
    }
    if (starting) return
    val host = (context.applicationContext as? ReactApplication)?.reactHost ?: return
    val running = host.currentReactContext
    if (running != null && running.hasActiveReactInstance()) {
      // The runtime runs (an activity, or a task we started earlier): run the task in it, even
      // when the car controller already listens (an activity's runtime, now in the background).
      // Only a running headless task keeps React Native's JS timers firing while no activity is
      // resumed, and the car sync's snapshot writes are timers: without one, a car connecting to
      // a backgrounded app kept its old lists for the whole drive. The task's steps are all
      // idempotent with the root layout's; startTask is a no-op while ours still runs.
      startTask(running)
      return
    }
    if (PlayerBridge.jsListening) return
    starting = true
    host.addReactInstanceEventListener(
      object : ReactInstanceEventListener {
        override fun onReactContextInitialized(context: ReactContext) {
          host.removeReactInstanceEventListener(this)
          main.post {
            starting = false
            startTask(context)
          }
        }
      },
    )
    try {
      host.start()
    } catch (e: Exception) {
      starting = false
      Log.w(TAG, "Could not start the JS runtime", e)
    }
  }

  /** The service no longer needs JS (no car, nothing playing): finish our task so RN's task
   * bookkeeping is clean. It doesn't stop JS; the JS task resolves itself on the car leaving. */
  fun release() {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      main.post { release() }
      return
    }
    val id = taskId ?: return
    val ctx = taskContext
    taskId = null
    taskContext = null
    if (ctx != null) {
      try {
        HeadlessJsTaskContext.getInstance(ctx).finishTask(id)
      } catch (e: Exception) {
        Log.w(TAG, "Could not finish the car task", e)
      }
    }
  }

  private fun startTask(context: ReactContext) {
    val previous = taskId
    if (previous != null && taskContext === context &&
      HeadlessJsTaskContext.getInstance(context).isTaskRunning(previous)
    ) {
      return
    }
    try {
      // No timeout (0): the task lives while the service has a book or the car is connected,
      // and release() ends it. Allowed in the foreground: the activity may be open.
      val config = HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true)
      taskId = HeadlessJsTaskContext.getInstance(context).startTask(config)
      taskContext = context
    } catch (e: Exception) {
      Log.w(TAG, "Could not start the car task", e)
    }
  }
}
