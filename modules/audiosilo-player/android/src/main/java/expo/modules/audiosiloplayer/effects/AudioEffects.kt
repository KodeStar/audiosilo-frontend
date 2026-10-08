package expo.modules.audiosiloplayer.effects

import android.content.Context
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.RenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Smart Speed + Voice Boost on Android (Phase 6 contract, decisions 6-8): the one seam the
 * service and the module use. Process-wide state, because the service may build a new player
 * (a new sink and chain) while the module and JS live on:
 *  - the Voice Boost switch, read by every [VoiceBoostProcessor] once per buffer;
 *  - the book time removed by silence skipping, summed over every chain built in this process.
 */
@androidx.annotation.OptIn(UnstableApi::class)
object AudioEffects {
  private const val PREFS = "audiosilo.player" // AudiosiloPlayerService.PREFS
  private const val KEY_SMART = "effects.smart"
  private const val KEY_BOOST = "effects.boost"

  private val boostSwitch = AtomicBoolean(false)
  private val silenceSavedUs = AtomicLong(0)

  /**
   * Renderers factory whose audio sink chain is [NarrationSilenceProcessor, Sonic,
   * VoiceBoostProcessor]. Otherwise exactly ExoPlayer's default (pass it to
   * `ExoPlayer.Builder(context, renderersFactory)` or `setRenderersFactory`).
   */
  fun renderersFactory(context: Context): RenderersFactory =
    EffectsRenderersFactory(context.applicationContext)

  /**
   * Apply the listener's switches (silence skipping through player.setSkipSilenceEnabled; the
   * boost processor's own flag, ramped). Safe on any thread the player is used on (main).
   *
   * Smart Speed goes through ExoPlayer, not straight to the processor: the sink must drain and
   * flush around the change and re-checkpoint its position maths, which only it can do. Voice
   * Boost is only a flag (the processor ramps; no flush, no gap).
   */
  fun apply(player: ExoPlayer, smartSpeed: Boolean, voiceBoost: Boolean) {
    if (player.skipSilenceEnabled != smartSpeed) player.skipSilenceEnabled = smartSpeed
    boostSwitch.set(voiceBoost)
  }

  /** Book seconds removed by silence skipping since the process started; monotonic. */
  val silenceSavedSeconds: Double
    get() = silenceSavedUs.get() / 1_000_000.0

  /**
   * Last applied switches, persisted in SharedPreferences "audiosilo.player" (keys effects.smart,
   * effects.boost) so a service started without JS applies them. Default off.
   */
  fun load(context: Context): Pair<Boolean, Boolean> {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return prefs.getBoolean(KEY_SMART, false) to prefs.getBoolean(KEY_BOOST, false)
  }

  fun save(context: Context, smartSpeed: Boolean, voiceBoost: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_SMART, smartSpeed)
      .putBoolean(KEY_BOOST, voiceBoost)
      .apply()
  }

  /** A new chain wired to the process-wide switch and counter (one per sink). */
  internal fun newChain(): AudiosiloAudioChain =
    AudiosiloAudioChain(
      silence = NarrationSilenceProcessor(savedUs = silenceSavedUs),
      boost = VoiceBoostProcessor(switch = boostSwitch),
    )

  /**
   * ExoPlayer's default renderers with our chain in the sink. The sink is built as 1.5.1's
   * `DefaultRenderersFactory.buildAudioSink` builds it (same float-output and AudioTrack
   * playback-params flags, both off by default; default offload support and buffer sizes), so
   * nothing but the processors changes. Keep float output OFF: with it on, the sink skips the
   * whole chain for high-resolution PCM (no speed, no Smart Speed, no Voice Boost).
   */
  private class EffectsRenderersFactory(context: Context) : DefaultRenderersFactory(context) {
    override fun buildAudioSink(
      context: Context,
      enableFloatOutput: Boolean,
      enableAudioTrackPlaybackParams: Boolean,
    ): AudioSink =
      DefaultAudioSink.Builder(context)
        .setEnableFloatOutput(enableFloatOutput)
        .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
        .setAudioProcessorChain(newChain())
        .build()
  }
}
