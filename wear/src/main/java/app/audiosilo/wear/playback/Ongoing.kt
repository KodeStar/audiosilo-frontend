// The ongoing activity (a Wear OS quality rule): while a book plays, the media notification Media3
// posts for the session carries an OngoingActivity, so the watch face and the app launcher show
// AudioSilo is playing and a tap opens it. Media3's default provider builds the notification;
// this hooks in where it holds the NotificationCompat.Builder (`addNotificationActions`).
//
// And the output switcher: the speaker question's No (decision 10). Media3 1.9.0 does not open it
// on an unsuitable output (W4-0 check 3), so the app does: the system's media output panel for
// this package, else the Bluetooth device picker (both resolve on Wear OS 5.1 and 6).
package app.audiosilo.wear.playback

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaNotification
import androidx.media3.session.MediaSession
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status
import app.audiosilo.wear.R
import com.google.common.collect.ImmutableList

class OngoingNotification(private val context: Context) : DefaultMediaNotificationProvider(context) {
  override fun addNotificationActions(
    mediaSession: MediaSession,
    mediaButtons: ImmutableList<CommandButton>,
    builder: NotificationCompat.Builder,
    actionFactory: MediaNotification.ActionFactory,
  ): IntArray {
    val compact = super.addNotificationActions(mediaSession, mediaButtons, builder, actionFactory)
    val player = mediaSession.player
    if (player.playWhenReady) {
      val title = player.mediaMetadata.title?.toString() ?: context.getString(R.string.app_name)
      builder.setOngoing(true).setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      OngoingActivity.Builder(context, DEFAULT_NOTIFICATION_ID, builder)
        .setStaticIcon(R.drawable.ic_launcher)
        .setTouchIntent(PlaybackService.openApp(context))
        .setStatus(Status.Builder().addTemplate(title).build())
        .build()
        .apply(context)
    }
    return compact
  }
}

object OutputSwitcher {
  private const val MEDIA_OUTPUT = "com.android.settings.panel.action.MEDIA_OUTPUT"
  private const val EXTRA_PACKAGE = "com.android.settings.panel.extra.PACKAGE_NAME"

  /** Open where the listener picks headphones. False when nothing on this watch can. */
  fun open(context: Context): Boolean {
    val flags = Intent.FLAG_ACTIVITY_NEW_TASK
    val panel = Intent(MEDIA_OUTPUT).putExtra(EXTRA_PACKAGE, context.packageName).addFlags(flags)
    val bluetooth =
      Intent("android.settings.BLUETOOTH_SETTINGS")
        .putExtra("EXTRA_CLOSE_ON_CONNECT", true)
        .putExtra("EXTRA_CONNECTION_ONLY", true)
        .putExtra("android.bluetooth.devicepicker.extra.FILTER_TYPE", 1)
        .addFlags(flags)
    for (intent in listOf(panel, bluetooth)) {
      try {
        context.startActivity(intent)
        return true
      } catch (_: ActivityNotFoundException) {
      } catch (_: SecurityException) {}
    }
    return false
  }
}
