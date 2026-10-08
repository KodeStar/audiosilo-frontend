package expo.modules.audiosiloplayer.effects

import android.content.Context
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.RenderersFactory

// STUB (WS-D only): the seam WS-C owns, with its exact signature, so the service compiles on its
// own branch. The main session drops this commit at merge in favour of WS-C's real file.
@androidx.annotation.OptIn(UnstableApi::class)
object AudioEffects {
  private const val PREFS = "audiosilo.player"
  private const val KEY_SMART = "effects.smart"
  private const val KEY_BOOST = "effects.boost"

  /** Renderers factory whose audio sink chain is [NarrationSilenceProcessor, Sonic, VoiceBoostProcessor]. */
  fun renderersFactory(context: Context): RenderersFactory = DefaultRenderersFactory(context)

  /** Apply the listener's switches. Safe on any thread the player is used on (main). */
  fun apply(player: ExoPlayer, smartSpeed: Boolean, voiceBoost: Boolean) {
    player.skipSilenceEnabled = smartSpeed
  }

  /** Book seconds removed by silence skipping since the process started; monotonic. */
  val silenceSavedSeconds: Double
    get() = 0.0

  fun load(context: Context): Pair<Boolean, Boolean> {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return Pair(prefs.getBoolean(KEY_SMART, false), prefs.getBoolean(KEY_BOOST, false))
  }

  fun save(context: Context, smartSpeed: Boolean, voiceBoost: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putBoolean(KEY_SMART, smartSpeed)
      .putBoolean(KEY_BOOST, voiceBoost)
      .apply()
  }
}
