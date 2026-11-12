// The watch's player, the twin of targets/watch/Playback/WatchAudioEngine.swift on Media3 (W4
// decision 10): one ExoPlayer over a downloaded book's watch rendition files, one MediaItem per
// file; speech audio attributes with audio focus handled, `setHandleAudioBecomingNoisy(true)`,
// and `setSuppressPlaybackOnUnsuitableOutput(true)` until the listener has said yes to the
// watch's own speaker once (the one-time question: Yes rebuilds the player without suppression, No
// opens the system's output switcher). PlaybackService puts the player (through ChapterPlayer,
// which maps the system's next / previous to chapters and its skips to 15 / 30 s) in a
// MediaSession, so the system's media controls and the ongoing activity work.
//
// Every position is whole-book seconds (Timeline). The engine tells the SpanRecorder what happens:
// a span opens on play; closes on pause, a move, a stop, the end (then `finish`) and the sleep
// timer; is cut every 15 s while the server is reachable (else after an hour), on a rate change
// and on going to the background; and is kept every 5 s. A pause the system makes (focus lost,
// headphones gone, an unsuitable output) is read from Media3's change reasons (SystemPause) and
// ends its span where the audio last moved. Main thread only.
package app.audiosilo.wear.playback

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import app.audiosilo.wear.core.BookRef
import app.audiosilo.wear.core.ChapterNav
import app.audiosilo.wear.core.Halt
import app.audiosilo.wear.core.ListeningStart
import app.audiosilo.wear.core.LocalPlace
import app.audiosilo.wear.core.Located
import app.audiosilo.wear.core.NowPlayingTimes
import app.audiosilo.wear.core.PlaceStore
import app.audiosilo.wear.core.PlaybackAttempt
import app.audiosilo.wear.core.PlaybackFailure
import app.audiosilo.wear.core.PlaybackSpeed
import app.audiosilo.wear.core.PlayingBook
import app.audiosilo.wear.core.ResumePlan
import app.audiosilo.wear.core.SleepMode
import app.audiosilo.wear.core.SleepTimer
import app.audiosilo.wear.core.SpanEnd
import app.audiosilo.wear.core.SpanRecorder
import app.audiosilo.wear.core.Spans
import app.audiosilo.wear.core.Skips
import app.audiosilo.wear.core.SystemPause
import app.audiosilo.wear.core.Timeline
import app.audiosilo.wear.core.secondsSince
import java.io.File
import java.time.Instant
import kotlin.math.abs
import kotlin.math.roundToLong
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** A downloaded book ready to play. */
data class LoadedBook(
  val ref: BookRef,
  val title: String,
  val author: String?,
  val timeline: Timeline,
  /** The local file per timeline file, in order. */
  val files: List<File>,
) {
  val playing: PlayingBook
    get() = PlayingBook(ref, timeline.audio)
}

/** What Now Playing reads. */
data class PlayerState(
  val book: LoadedBook? = null,
  /** The listener wants it playing (the button shows Pause). */
  val playing: Boolean = false,
  val position: Double = 0.0,
  val rate: Double = 1.0,
  val sleep: SleepTimer? = null,
  val times: NowPlayingTimes? = null,
  /** The only output is the watch's speaker and the listener has not said yes to it yet. */
  val speakerPrompt: Boolean = false,
  val problem: String? = null,
)

class PlayerEngine(private val context: Context, private val spans: SpanRecorder, private val places: PlaceStore) {
  private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private val handler = Handler(Looper.getMainLooper())

  private val _state = MutableStateFlow(PlayerState(rate = PlaybackSpeed.book(null, prefs.getFloat(SPEED_KEY, 0f).toDouble())))
  val state: StateFlow<PlayerState> = _state.asStateFlow()

  /** Whether the server answered the last sync (the 15 s cut runs only then). */
  var reachable: () -> Boolean = { true }

  /** Told when the loaded book plays again after `PICKED_UP_AFTER` of pause. */
  var onPickedUp: (() -> Unit)? = null

  /** Told when the session's player changes (a rebuild without suppression): PlaybackService's session follows. */
  var onPlayerChanged: ((Player) -> Unit)? = null

  private var exo: ExoPlayer? = null
  private var chapterPlayer: ChapterPlayer? = null

  private var book: LoadedBook? = null
  private var playing = false
  private var position = 0.0
  private var rate = _state.value.rate
  private var sleep: SleepTimer? = null
  private var speakerPrompt = false
  private var problem: String? = null

  private var lastTick = Instant.now()
  private var lastKeep = Instant.now()
  private var lastCut = Instant.now()

  /** When the place last moved while playing (where a late-noticed stop ends its span). */
  private var lastAdvance = Instant.now()

  /** When it last paused, for `onPickedUp`. */
  private var pausedAt: Instant? = null

  /** The book played to its end: the next play starts it again. */
  private var ended = false

  /** Cleared when audio first moves, so a start that never comes says so (`watchStart`). */
  private var awaitingAudio = false

  /** Deadlines belong to one uninterrupted play. */
  private val attempt = PlaybackAttempt()
  private var ticking = false

  val loadedBook: BookRef?
    get() = book?.ref

  val isPlaying: Boolean
    get() = playing

  val currentPosition: Double
    get() = position

  val speakerConfirmed: Boolean
    get() = prefs.getBoolean(SPEAKER_KEY, false)

  // The player

  /** The player the media session holds, built on first need. */
  fun sessionPlayer(): Player = chapterPlayer ?: run {
    build(suppress = !speakerConfirmed)
    chapterPlayer!!
  }

  private fun player(): ExoPlayer = exo ?: run {
    build(suppress = !speakerConfirmed)
    exo!!
  }

  private fun build(suppress: Boolean) {
    val p =
      ExoPlayer.Builder(context)
        .setAudioAttributes(
          AudioAttributes.Builder().setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).setUsage(C.USAGE_MEDIA).build(),
          /* handleAudioFocus= */ true,
        )
        .setHandleAudioBecomingNoisy(true)
        .setSuppressPlaybackOnUnsuitableOutput(suppress)
        .setWakeMode(C.WAKE_MODE_LOCAL)
        .setSeekBackIncrementMs(ms(Skips.BACK))
        .setSeekForwardIncrementMs(ms(Skips.FORWARD))
        .build()
    p.addListener(listener)
    p.playbackParameters = PlaybackParameters(rate.toFloat())
    exo = p
    chapterPlayer = ChapterPlayer(p, this)
  }

  /**
   * The listener said yes to the speaker: a new player without suppression at the same place (Media3
   * reads the flag only when built), handed to the session, the old one released.
   */
  private fun rebuildWithoutSuppression() {
    val old = exo
    val at = where()
    old?.removeListener(listener)
    build(suppress = false)
    book?.let { b -> setItems(b, at?.index ?: 0, at?.positionInTrack ?: 0.0) }
    chapterPlayer?.let { onPlayerChanged?.invoke(it) }
    old?.release()
  }

  private fun setItems(b: LoadedBook, index: Int, seconds: Double) {
    val p = player()
    val meta = MediaMetadata.Builder().setTitle(b.title).setAlbumTitle(b.title).setArtist(b.author).build()
    val items =
      b.files.mapIndexed { i, f -> MediaItem.Builder().setMediaId("$i").setUri(Uri.fromFile(f)).setMediaMetadata(meta).build() }
    p.setMediaItems(items, index, ms(seconds))
    p.prepare()
  }

  // The place

  /** The file playing and the seconds into it. */
  private fun where(): Located? {
    val p = exo ?: return null
    if (p.mediaItemCount == 0 || book == null) return null
    val t = p.currentPosition / 1000.0
    return if (t.isFinite()) Located(p.currentMediaItemIndex, t) else null
  }

  /** The place now as a span end (null when the player reports nothing that is a number). */
  private fun spanEnd(): SpanEnd? {
    val b = book ?: return null
    val w = where() ?: b.timeline.locate(position)
    return b.timeline.spanEnd(w.index, w.positionInTrack)
  }

  /**
   * Kept only as the book plays or moves, with the time that happened (`at`, else now): a place
   * stamped later than it was heard would read as newer than another device's real one.
   */
  private fun savePlace(at: Instant? = null) {
    val b = book ?: return
    val end = spanEnd() ?: return
    places.set(b.ref, LocalPlace.of(end, at ?: Instant.now(), rate))
  }

  // Loading

  /** Load `next` at `plan`'s place and its own speed (a book already loaded is stopped first, its span closed). */
  fun load(next: LoadedBook, plan: ResumePlan, savedSpeed: Double?) {
    if (book != null) stop()
    book = next
    problem = null
    rate = PlaybackSpeed.book(savedSpeed, prefs.getFloat(SPEED_KEY, 0f).toDouble())
    player().playbackParameters = PlaybackParameters(rate.toFloat())
    spans.prepareStart(plan.start, plan.unfinish)
    val place = next.timeline.resumePlace(plan.position, plan.file, plan.filePos)
    position = next.timeline.bookPosition(place.index, place.positionInTrack)
    ended = false
    setItems(next, place.index, place.positionInTrack)
    startTicks()
    publish()
  }

  // Transport

  /** Play; the speaker asked about once when it is the only output. */
  fun play() {
    val b = book ?: return
    if (playing) return
    problem = null
    val p = player()
    if (ended) {
      // Played to the end: start again (an `unfinish`, then a `restart` span).
      spans.prepareStart(ListeningStart.RESTART, unfinish = true)
      position = 0.0
      ended = false
      p.seekTo(0, 0)
    }
    if (p.mediaItemCount == 0) {
      val place = b.timeline.locate(position)
      setItems(b, place.index, place.positionInTrack)
    } else if (p.playbackState == Player.STATE_IDLE) {
      // A failed file: try it again from the place.
      p.prepare()
    }
    if (SystemPause.asksSpeaker(SystemPause.ofSuppression(p.playbackSuppressionReason), speakerConfirmed)) {
      speakerPrompt = true
      publish()
      return
    }
    startPlaying()
  }

  /** The listener said yes to the watch's speaker (once, kept). */
  fun confirmSpeaker() {
    prefs.edit().putBoolean(SPEAKER_KEY, true).apply()
    speakerPrompt = false
    rebuildWithoutSuppression()
    startPlaying()
  }

  /** The listener said no: the caller opens the output switcher (OutputSwitcher). */
  fun declineSpeaker() {
    speakerPrompt = false
    publish()
  }

  private fun startPlaying() {
    val b = book ?: return
    if (playing) return
    sleep = sleep?.resumed(Instant.now())
    val now = Instant.now()
    val pickedUp = pausedAt?.let { now.secondsSince(it) >= PICKED_UP_AFTER } ?: false
    pausedAt = null
    PlaybackService.start(context)
    playing = true
    awaitingAudio = true
    lastTick = now
    lastKeep = now
    lastCut = now
    lastAdvance = now
    player().play()
    // Media3 tells its listeners inside play(): an output it refuses (the speaker not yet agreed
    // to) has paused this play already, so no span opens on a book that is not playing.
    if (playing) {
      watchStart()
      spanEnd()?.let { spans.open(b.playing, it, rate) }
      publish()
    }
    if (pickedUp) onPickedUp?.invoke()
  }

  /** A play whose audio never starts (no file ready, a refused route) can be tried again. */
  private fun watchStart() {
    val token = attempt.advance()
    handler.postDelayed(
      {
        if (attempt.timedOut(token, awaitingAudio, playing)) {
          pause(stoppedAt = lastAdvance)
          problem = PlaybackFailure.SETTLING.message
          publish()
        }
      },
      START_LIMIT_MS,
    )
  }

  /** The listener's pause. */
  fun pause() = pause(stoppedAt = null)

  private fun pause(stoppedAt: Instant?) {
    attempt.advance()
    awaitingAudio = false
    if (!playing) return
    playing = false
    exo?.pause()
    pausedAt = stoppedAt ?: Instant.now()
    spans.close(spanEnd(), stoppedAt)
    savePlace(stoppedAt)
    sleep = sleep?.paused(Instant.now())
    publish()
  }

  fun toggle() = if (playing) pause() else play()

  /**
   * Stop and unload (removing the playing book, signing out, another book loading). A book not
   * playing keeps the place it has.
   */
  fun stop() {
    pause()
    pausedAt = null
    speakerPrompt = false
    spans.close(null)
    exo?.let {
      it.stop()
      it.clearMediaItems()
    }
    ended = false
    book = null
    sleep = null
    problem = null
    stopTicks()
    publish()
  }

  /** Move to `target` (whole-book seconds). `reason` null: a jump, or moved back when behind. */
  fun seek(target: Double, reason: ListeningStart? = null) {
    val b = book ?: return
    val to = Skips.target(target, 0.0, b.timeline.total)
    val place = b.timeline.locate(to)
    val end = b.timeline.spanEnd(place.index, place.positionInTrack)
    // Previous at the book's start: nothing moves, so no span and no newer time on the place.
    val from = spanEnd()
    if (reason == null && Spans.movesNowhere(from, end) && abs(position - to) < ChapterNav.AT_START) return
    // Moved back into a book that played to its end: it is finished on the server and a listen
    // never unfinishes, so the next play sends the `unfinish` (its reason stays the move's).
    if (ended) spans.prepareStart(spans.nextStart, unfinish = true)
    spans.move(b.playing, end, from, reason, playing, rate)
    ended = false
    val p = player()
    if (p.mediaItemCount == 0) setItems(b, place.index, place.positionInTrack) else p.seekTo(place.index, ms(place.positionInTrack))
    position = to
    // A chapter timer's stop crossed while paused has nothing left to stop.
    if (!playing && sleep?.due(to) == true) sleep = null
    val now = Instant.now()
    end?.let { places.set(b.ref, LocalPlace.of(it, now, rate)) }
    lastKeep = now
    lastCut = now
    lastAdvance = now
    publish()
  }

  fun skip(delta: Double) {
    val b = book ?: return
    seek(Skips.target(position, delta, b.timeline.total))
  }

  fun previousChapter() {
    val b = book ?: return
    val to = ChapterNav.previous(b.timeline.chapters, position) ?: return skip(-Skips.BACK)
    seek(to)
  }

  fun nextChapter() {
    val b = book ?: return
    val to = ChapterNav.next(b.timeline.chapters, position) ?: return
    seek(to)
  }

  fun setRate(r: Double) {
    val next = PlaybackSpeed.clamp(r)
    if (next == rate) return
    book?.let { spans.cut(it.playing, spanEnd(), playing, next) }
    rate = next
    prefs.edit().putFloat(SPEED_KEY, next.toFloat()).apply()
    exo?.playbackParameters = PlaybackParameters(next.toFloat())
    // The book's own from now on. Its place's time stays: the place did not move.
    book?.let { b -> places.place(b.ref)?.let { places.set(b.ref, it.copy(speed = next)) } }
    publish()
  }

  fun setSleep(mode: SleepMode?) {
    val b = book
    if (mode == null || b == null) {
      sleep = null
      publish()
      return
    }
    sleep = SleepTimer.arm(mode, position, rate, b.timeline.chapters, b.timeline.total).let { if (!playing) it.paused(Instant.now()) else it }
    publish()
  }

  /** Going to the background while playing: the span is cut (Sync v2's trigger), and the place kept. */
  fun cutForBackground() {
    val b = book ?: return
    if (!playing) return
    spans.cut(b.playing, spanEnd(), true, rate)
    savePlace()
  }

  /** An offer answered with Stay: the next span is a deliberate move. */
  fun stay() {
    val b = book ?: return
    spans.standBy(b.playing, spanEnd(), playing, rate)
  }

  // What Media3 says

  private val listener =
    object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (!isPlaying) return
        awaitingAudio = false
        lastAdvance = Instant.now()
        // Back after a transient focus loss: Media3 resumed by itself, so a new span opens here.
        val b = book ?: return
        if (playing && spans.span == null) spanEnd()?.let { spans.open(b.playing, it, rate) }
      }

      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        // The engine's own pause flips `playing` first; only one the system made gets here.
        if (playWhenReady || !playing) return
        val halt = SystemPause.ofPlayWhenReady(reason) ?: return pause(stoppedAt = null)
        systemPause(halt)
      }

      override fun onPlaybackSuppressionReasonChanged(reason: Int) {
        val halt = SystemPause.ofSuppression(reason) ?: return
        if (!playing) return
        if (SystemPause.keepsPlaying(halt)) {
          // A call or an alert holds the audio: the span ends where it last moved, the wish to play stays.
          spans.close(spanEnd(), lastAdvance)
          savePlace(lastAdvance)
          return
        }
        systemPause(halt)
      }

      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_ENDED) bookEnded()
      }

      override fun onPlayerError(error: PlaybackException) {
        pause(stoppedAt = lastAdvance)
        problem = PlaybackFailure.ofError(error.errorCode, error.cause).message
        publish()
      }
    }

  /** A pause the system made: its span ends where the audio last moved. */
  private fun systemPause(halt: Halt) {
    pause(stoppedAt = lastAdvance)
    if (SystemPause.asksSpeaker(halt, speakerConfirmed)) speakerPrompt = true
    SystemPause.message(halt)?.let { problem = it }
    publish()
  }

  /** The book's end: its last span closed, then one `finish`. */
  private fun bookEnded() {
    val b = book ?: return
    val last = b.timeline.files.size - 1
    if (last < 0) return
    val lastDuration = b.timeline.files[last].duration
    val end = b.timeline.spanEnd(last, if (lastDuration > 0) lastDuration else (exo?.currentPosition ?: 0) / 1000.0)
    attempt.advance()
    playing = false
    exo?.pause()
    ended = true
    spans.finish(b.playing, end)
    position = b.timeline.total
    places.set(b.ref, LocalPlace(position = b.timeline.total, at = Instant.now(), speed = rate))
    sleep = null
    publish()
  }

  // Ticks

  private val tickRunnable =
    object : Runnable {
      override fun run() {
        tick()
        if (ticking) handler.postDelayed(this, TICK_MS)
      }
    }

  private fun startTicks() {
    if (ticking) return
    ticking = true
    handler.postDelayed(tickRunnable, TICK_MS)
  }

  private fun stopTicks() {
    ticking = false
    handler.removeCallbacks(tickRunnable)
  }

  private fun tick() {
    val b = book ?: return
    val now = Instant.now()
    val wall = now.secondsSince(lastTick)
    lastTick = now
    where()?.let { w ->
      val p = b.timeline.bookPosition(w.index, w.positionInTrack)
      if (p.isFinite()) {
        if (playing && p != position) {
          lastAdvance = now
          awaitingAudio = false
        }
        position = p
      }
    }
    publish()
    if (!playing) return
    // Only audio that moved counts down (a transient focus loss keeps `playing`).
    if (exo?.isPlaying == true) {
      sleep?.let { s ->
        val next = s.played(wall)
        sleep = next
        if (next.due(position)) {
          sleep = null
          pause()
          return
        }
      }
    }
    var moved = false
    if (now.secondsSince(lastKeep) >= Spans.OPEN_SPAN_KEEP) {
      lastKeep = now
      spans.keep(spanEnd())
      moved = true
    }
    if (now.secondsSince(lastCut) >= Spans.CUT_INTERVAL) {
      lastCut = now
      // Held by a transient focus loss there is no span, and none opens until the audio moves.
      if (exo?.isPlaying == true || spans.span != null) spans.tick(b.playing, spanEnd(), true, reachable(), rate)
      moved = true
    }
    // Held by a call or an alert nothing moved: the place keeps the time the audio last did
    // (the hold saved it at `lastAdvance`), or it would look newer than another device's.
    if (moved && exo?.isPlaying == true) savePlace()
  }

  // Now Playing

  /** Tell the screens what is so now (a state equal to the last one is not sent again). */
  private fun publish() {
    val b = book
    val times = b?.let { NowPlayingTimes.of(it.timeline.chapters, position, it.timeline.total, it.title) }
    _state.value = PlayerState(b, playing, position, rate, sleep, times, speakerPrompt, problem)
  }

  companion object {
    const val TICK_MS = 500L

    /** A play after this long paused is a book picked up again (the phone's `LONG_PAUSE_MS`). */
    const val PICKED_UP_AFTER = 60.0

    /** A play whose audio has not started after this long is given up (the Apple Watch's settle limit). */
    const val START_LIMIT_MS = 30_000L

    private const val PREFS = "player"
    private const val SPEED_KEY = "playbackSpeed"
    private const val SPEAKER_KEY = "speakerConfirmed"

    fun ms(seconds: Double): Long = if (seconds.isFinite() && seconds > 0) (seconds * 1000).roundToLong() else 0L
  }
}
