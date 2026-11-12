// Now Playing, the twin of targets/watch/UI/NowPlaying.swift: the chapter and its times, play /
// pause, skip back 15 and forward 30, previous / next chapter, the wall-clock line off 1x, and the
// Chapters, Speed and Sleep screens. Opened with a start (a book's Play), it shows that book
// starting (pull before play, AppModel.play); opened from Home, the book already loaded.
package app.audiosilo.wear.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.itemsIndexed
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.FilledIconButton
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.FilledTonalIconButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.LinearProgressIndicator
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import app.audiosilo.wear.AppModel
import app.audiosilo.wear.core.ChapterNav
import app.audiosilo.wear.core.Labels
import app.audiosilo.wear.core.PlaybackSpeed
import app.audiosilo.wear.core.SleepTimer
import app.audiosilo.wear.core.Skips
import app.audiosilo.wear.playback.PlayerState
import kotlinx.coroutines.Job

@Composable
fun NowPlayingScreen(model: AppModel, start: Job?, onChapters: () -> Unit, onSpeed: () -> Unit, onSleep: () -> Unit) {
  val s by model.engine.state.collectAsState()
  var startFinished by remember(start) { mutableStateOf(start == null || start.isCompleted) }
  LaunchedEffect(start) {
    start?.join()
    startFinished = true
  }
  val engine = model.engine
  ListScreen {
    val book = s.book
    if (book == null) {
      item {
        when {
          !startFinished -> CircularProgressIndicator()
          start != null -> Note(CANT_START)
          else -> Note("Nothing playing")
        }
      }
      return@ListScreen
    }
    item {
      Text(
        s.times?.title ?: book.title,
        style = MaterialTheme.typography.titleMedium,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth(),
      )
    }
    if (s.times?.chapterIndex != null) item { Note(book.title, center = true) }
    val t = s.times
    if (t != null && t.duration > 0) {
      item { LinearProgressIndicator(progress = { (t.elapsed / t.duration).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth()) }
      item { Note(timesLine(s), center = true) }
      Skips.wallClockLine(t.elapsed, t.duration, s.rate)?.let { line -> item { Note(line, center = true) } }
    }
    item {
      Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        FilledTonalIconButton(onClick = { engine.skip(-Skips.BACK) }, modifier = Modifier.semantics { contentDescription = "Back 15 seconds" }) {
          Text("15")
        }
        FilledIconButton(onClick = { engine.toggle() }) {
          Icon(if (s.playing) Glyphs.pause else Glyphs.play, contentDescription = if (s.playing) "Pause" else "Play")
        }
        FilledTonalIconButton(onClick = { engine.skip(Skips.FORWARD) }, modifier = Modifier.semantics { contentDescription = "Forward 30 seconds" }) {
          Text("30")
        }
      }
    }
    if (book.timeline.chapters.isNotEmpty()) {
      item {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
          FilledTonalIconButton(onClick = { engine.previousChapter() }) { Icon(Glyphs.previous, contentDescription = "Previous chapter") }
          FilledTonalIconButton(onClick = { engine.nextChapter() }) { Icon(Glyphs.next, contentDescription = "Next chapter") }
        }
      }
    }
    s.problem?.let { item { Note(it) } }
    if (book.timeline.chapters.isNotEmpty()) {
      item { FilledTonalButton(onClick = onChapters, modifier = Modifier.fillMaxWidth(), label = { Text("Chapters") }) }
    }
    item { FilledTonalButton(onClick = onSpeed, modifier = Modifier.fillMaxWidth(), label = { Text("Speed ${PlaybackSpeed.label(s.rate)}") }) }
    item { FilledTonalButton(onClick = onSleep, modifier = Modifier.fillMaxWidth(), label = { Text(sleepLabel(s)) }) }
  }
}

/** "1:02 · -3:15", the chapter's (else the book's) figures in whole seconds. */
fun timesLine(s: PlayerState): String {
  val t = s.times ?: return ""
  val f = Skips.figures(t.elapsed, t.duration)
  return "${Labels.clock(f.elapsed)}  -${Labels.clock(f.left)}"
}

fun sleepLabel(s: PlayerState): String = s.sleep?.let { "Sleep in ${Labels.clock(it.left(s.position, s.rate))}" } ?: "Sleep timer"

@Composable
fun ChaptersScreen(model: AppModel, done: () -> Unit) {
  val s by model.engine.state.collectAsState()
  val chapters = s.book?.timeline?.chapters ?: emptyList()
  val current = s.times?.chapterIndex
  ListScreen {
    item { ListHeader { Text("Chapters") } }
    itemsIndexed(chapters) { i, ch ->
      Button(
        onClick = {
          model.engine.seek(ch.bookOffset)
          done()
        },
        modifier = Modifier.fillMaxWidth(),
        secondaryLabel = if (i == current) ({ Text("Playing") }) else null,
        label = { Text(ChapterNav.title(ch, i), maxLines = 2, overflow = TextOverflow.Ellipsis) },
      )
    }
  }
}

@Composable
fun SpeedScreen(model: AppModel, done: () -> Unit) {
  val s by model.engine.state.collectAsState()
  ListScreen {
    item { ListHeader { Text("Speed") } }
    PlaybackSpeed.PRESETS.forEach { r ->
      item {
        Button(
          onClick = {
            model.engine.setRate(r)
            done()
          },
          modifier = Modifier.fillMaxWidth(),
          secondaryLabel = if (r == s.rate) ({ Text("Now") }) else null,
          label = { Text(PlaybackSpeed.label(r)) },
        )
      }
    }
  }
}

@Composable
fun SleepScreen(model: AppModel, done: () -> Unit) {
  val s by model.engine.state.collectAsState()
  ListScreen {
    item { ListHeader { Text("Sleep timer") } }
    if (s.sleep != null) {
      item {
        Button(
          onClick = {
            model.engine.setSleep(null)
            done()
          },
          modifier = Modifier.fillMaxWidth(),
          label = { Text("Turn off") },
        )
      }
    }
    SleepTimer.CHOICES.forEach { mode ->
      item {
        FilledTonalButton(
          onClick = {
            model.engine.setSleep(mode)
            done()
          },
          modifier = Modifier.fillMaxWidth(),
          label = { Text(Labels.sleepChoice(mode)) },
        )
      }
    }
  }
}

const val CANT_START = "This book can't start now. Go back and try again."
