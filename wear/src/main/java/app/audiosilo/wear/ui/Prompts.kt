// The two questions over any screen, the twins of the Apple Watch's OfferSheet and SpeakerSheet:
// another device's place for the playing book (Jump / Stay; swiped away it is not offered again),
// and the one-time speaker question (decision 10: Yes plays on the speaker from now on, No opens
// the output switcher to pick headphones).
package app.audiosilo.wear.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.wear.compose.material3.AlertDialog
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.Text
import app.audiosilo.wear.AppModel
import app.audiosilo.wear.OfferPrompt
import app.audiosilo.wear.core.Labels
import app.audiosilo.wear.playback.OutputSwitcher

@Composable
fun Prompts(model: AppModel) {
  val offer by model.offerPrompt.collectAsState()
  val player by model.engine.state.collectAsState()
  val context = LocalContext.current
  val o = offer
  AlertDialog(
    visible = o != null,
    // Swiped away unanswered: not offered again (nothing acknowledged).
    onDismissRequest = { o?.let(model::ignore) },
    title = { Text(o?.let(::offerTitle) ?: "") },
    text = { Text("You are at ${Labels.clock(player.position)}.") },
  ) {
    item { Button(onClick = { o?.let(model::jump) }, modifier = Modifier.fillMaxWidth(), label = { Text("Jump there") }) }
    item { FilledTonalButton(onClick = { o?.let(model::stay) }, modifier = Modifier.fillMaxWidth(), label = { Text("Stay here") }) }
  }
  AlertDialog(
    visible = o == null && player.speakerPrompt,
    onDismissRequest = { model.engine.declineSpeaker() },
    title = { Text(SPEAKER_QUESTION) },
    text = { Text(SPEAKER_NOTE) },
  ) {
    item { Button(onClick = { model.engine.confirmSpeaker() }, modifier = Modifier.fillMaxWidth(), label = { Text("Play on speaker") }) }
    item {
      FilledTonalButton(
        onClick = {
          model.engine.declineSpeaker()
          OutputSwitcher.open(context)
        },
        modifier = Modifier.fillMaxWidth(),
        label = { Text("Choose headphones") },
      )
    }
  }
}

fun offerTitle(p: OfferPrompt): String {
  val who = p.offer.deviceName.ifEmpty { "Another device" }
  return "$who is at ${Labels.clock(p.offer.position)}."
}

const val SPEAKER_QUESTION = "Play on the watch speaker?"
const val SPEAKER_NOTE = "Others nearby will hear it. Connect headphones to listen privately."
