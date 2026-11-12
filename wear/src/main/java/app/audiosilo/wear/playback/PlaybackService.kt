// The media service (W4 decision 10): a MediaSessionService holding one MediaSession over the
// engine's player (ChapterPlayer), so the system's media controls drive the book and Media3 keeps
// the service in the foreground (mediaPlayback) while it plays. The engine owns the player; this
// service only shows it to the system, and follows a rebuilt player (`onPlayerChanged`). Its
// notification carries the ongoing activity (Ongoing). Started by the engine before the first play.
package app.audiosilo.wear.playback

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import app.audiosilo.wear.AppModel
import app.audiosilo.wear.MainActivity

class PlaybackService : MediaSessionService() {
  private var session: MediaSession? = null

  override fun onCreate() {
    super.onCreate()
    val engine = AppModel.get(this).engine
    setMediaNotificationProvider(OngoingNotification(this))
    setShowNotificationForIdlePlayer(SHOW_NOTIFICATION_FOR_IDLE_PLAYER_NEVER)
    val s = MediaSession.Builder(this, engine.sessionPlayer()).setSessionActivity(openApp(this)).build()
    session = s
    addSession(s)
    engine.onPlayerChanged = { p -> session?.player = p }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  override fun onDestroy() {
    AppModel.get(this).engine.onPlayerChanged = null
    // The engine keeps its player (a later play starts this service again around it).
    session?.release()
    session = null
    super.onDestroy()
  }

  companion object {
    /** Start the service before a play (from the app in front; Media3 then promotes it to the foreground). */
    fun start(context: Context) {
      try {
        context.startService(Intent(context, PlaybackService::class.java))
      } catch (_: IllegalStateException) {
        // Not allowed from the background: the session's own controller started it already, or
        // the play comes from the app in front next time.
      }
    }

    /** Open the app (the ongoing activity's and the session's touch target). */
    fun openApp(context: Context): PendingIntent {
      val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
  }
}
