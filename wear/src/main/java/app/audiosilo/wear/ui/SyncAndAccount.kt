// Sync and account, the twin of targets/watch/UI/SyncAndAccount.swift: the last sync, what waits,
// couldn't sync (each one dismissable), the address in use, the server's version, and Sign out,
// blocked while listening waits unless the listener discards it (decision 3).
package app.audiosilo.wear.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material3.AlertDialog
import androidx.wear.compose.material3.AlertDialogDefaults
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.OutlinedButton
import androidx.wear.compose.material3.Text
import app.audiosilo.wear.AppModel
import app.audiosilo.wear.core.CouldNotSync
import app.audiosilo.wear.core.Labels
import java.time.Instant
import kotlinx.coroutines.launch

@Composable
fun SyncScreen(model: AppModel, onSignOut: () -> Unit) {
  val revision by model.syncRevision.collectAsState()
  val syncing by model.syncing.collectAsState()
  val account by model.account.collectAsState()
  val server by model.server.collectAsState()
  val address by model.router.current.collectAsState()
  var dismissing by remember { mutableStateOf<CouldNotSync?>(null) }
  val outbox = model.outbox
  val failed = remember(revision) { outbox.couldNotSync() }
  val lines = remember(revision) { syncLines(outbox.state.lastSyncAt, outbox.unsentCount, outbox.lastFlushFailed, Instant.now()) }
  ListScreen {
    item { ListHeader { Text("Sync") } }
    lines.forEach { item { Note(it) } }
    item { SyncNowButton(model, syncing, outbox.unsentCount) }
    if (failed.isNotEmpty()) {
      item { ListHeader { Text("Couldn't sync") } }
      items(failed, key = { it.event.id }) { f ->
        Button(
          onClick = { dismissing = f },
          modifier = Modifier.fillMaxWidth(),
          colors = ButtonDefaults.filledTonalButtonColors(),
          secondaryLabel = { Text(Labels.ago(f.at, Instant.now())) },
          label = { Text(Labels.reason(f.reason), maxLines = 3) },
        )
      }
    }
    item { ListHeader { Text("Server") } }
    account?.let { a ->
      item { Note(a.serverName) }
      item { Note(address ?: model.router.base(a)) }
    }
    item { Note("Version ${server?.version ?: "unknown"}") }
    item { OutlinedButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth(), label = { Text("Sign out") }) }
  }
  val d = dismissing
  AlertDialog(
    visible = d != null,
    onDismissRequest = { dismissing = null },
    title = { Text("Dismiss this update?") },
    text = { Text("It will not be sent.") },
    confirmButton = {
      AlertDialogDefaults.ConfirmButton(
        onClick = {
          d?.let { model.outbox.discardFailed(it.event.id) }
          dismissing = null
        }
      )
    },
    dismissButton = { AlertDialogDefaults.DismissButton(onClick = { dismissing = null }) },
  )
}

/** What Sync says first: the last sync, what waits, and why it can't send now. */
fun syncLines(lastSyncAt: Instant?, waiting: Int, failed: Boolean, now: Instant): List<String> {
  val lines = ArrayList<String>()
  lines += "Last sync: " + (lastSyncAt?.let { Labels.ago(it, now) } ?: "not yet")
  lines += "Waiting: $waiting"
  if (failed && waiting > 0) lines += CANT_REACH_SYNC
  return lines
}

/** Sends what waits now (Sync, Sign out, a blocked replace). */
@Composable
fun SyncNowButton(model: AppModel, syncing: Boolean, waiting: Int) {
  Button(
    onClick = { model.scope.launch { model.flush() } },
    enabled = !syncing && waiting > 0,
    modifier = Modifier.fillMaxWidth(),
    label = { Text(if (syncing) "Syncing" else "Sync now") },
  )
}

@Composable
fun SignOutScreen(model: AppModel) {
  val revision by model.syncRevision.collectAsState()
  val syncing by model.syncing.collectAsState()
  val account by model.account.collectAsState()
  var confirming by remember { mutableStateOf(false) }
  val waiting = remember(revision) { model.outbox.unsentCount }
  ListScreen {
    item { ListHeader { Text("Sign out") } }
    account?.let { a -> item { Note("Signed in as ${a.userName} on ${a.serverName}.") } }
    if (waiting > 0) {
      item { Note(signOutBlocked(waiting)) }
      item { SyncNowButton(model, syncing, waiting) }
      item {
        FilledTonalButton(onClick = { confirming = true }, modifier = Modifier.fillMaxWidth(), label = { Text("Discard and sign out") })
      }
    } else {
      // Blocked (stopping the player closed a span), the count above takes over at once.
      item { Button(onClick = { model.signOut(discard = false) }, modifier = Modifier.fillMaxWidth(), label = { Text("Sign out") }) }
    }
    item { Note(SIGN_OUT_REMOVES) }
  }
  AlertDialog(
    visible = confirming,
    onDismissRequest = { confirming = false },
    title = { Text("Discard listening not synced yet?") },
    confirmButton = {
      AlertDialogDefaults.ConfirmButton(
        onClick = {
          confirming = false
          model.signOut(discard = true)
        }
      )
    },
    dismissButton = { AlertDialogDefaults.DismissButton(onClick = { confirming = false }) },
  )
}

fun signOutBlocked(waiting: Int): String = "${Labels.updates(waiting)} not synced yet. Sync first, or discard to sign out."

const val SIGN_OUT_REMOVES = "Signing out removes the books on this watch."
const val CANT_REACH_SYNC = "Can't reach your server. Listening is kept here and sent when it can be."
