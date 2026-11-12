// The Wear app's screens (Compose for Wear OS, Material 3), the twin of
// targets/watch/UI/Screens.swift: Setup, the "server too old" screen, Home (Now playing, what is on
// its way here, On this watch, Continue listening with Download or Play per row, Sync and Sign
// out) and On this watch (play, size, remove); Now Playing, Sync and the prompts have files of
// their own. Every list is a ScalingLazyColumn, which scrolls with the crown or bezel (rotary) by
// default, and fits round and square screens.
package app.audiosilo.wear.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListScope
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.AlertDialog
import androidx.wear.compose.material3.AlertDialogDefaults
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.OutlinedButton
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import app.audiosilo.wear.AppModel
import app.audiosilo.wear.core.ContinueRow
import app.audiosilo.wear.core.DownloadRecord
import app.audiosilo.wear.core.HeldBook
import app.audiosilo.wear.core.HeldBooks
import app.audiosilo.wear.core.Labels
import app.audiosilo.wear.core.WatchStateBook
import app.audiosilo.wear.phone.PhoneApp
import app.audiosilo.wear.playback.PlayerState
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

@Composable
fun WearApp(model: AppModel) {
  MaterialTheme {
    AppScaffold {
      val phase by model.phase.collectAsState()
      when (val p = phase) {
        is AppModel.Phase.Setup -> SetupScreen(model, p.status)
        is AppModel.Phase.TooOld -> TooOldNav(model, p.version)
        AppModel.Phase.Ready -> ReadyNav(model)
      }
    }
  }
}

@Composable
private fun ReadyNav(model: AppModel) {
  val nav = rememberSwipeDismissableNavController()
  // The play a book's Play started (Now Playing shows it starting), in the model's scope so leaving
  // the screen does not cut the pull before play short.
  var start by remember { mutableStateOf<Job?>(null) }
  val play: (DownloadRecord) -> Unit = { r ->
    start = model.startPlay(r)
    nav.navigate("now-playing")
  }
  SwipeDismissableNavHost(navController = nav, startDestination = "home") {
    composable("home") {
      HomeScreen(
        model,
        onThisWatch = { nav.navigate("on-watch") },
        onNowPlaying = {
          start = null
          nav.navigate("now-playing")
        },
        onPlay = play,
        onSync = { nav.navigate("sync") },
        onSignOut = { nav.navigate("sign-out") },
      )
    }
    composable("on-watch") { OnThisWatchScreen(model, onPlay = play) }
    composable("now-playing") {
      NowPlayingScreen(
        model,
        start,
        onChapters = { nav.navigate("chapters") },
        onSpeed = { nav.navigate("speed") },
        onSleep = { nav.navigate("sleep") },
      )
    }
    composable("chapters") { ChaptersScreen(model, done = { nav.popBackStack() }) }
    composable("speed") { SpeedScreen(model, done = { nav.popBackStack() }) }
    composable("sleep") { SleepScreen(model, done = { nav.popBackStack() }) }
    composable("sync") { SyncScreen(model, onSignOut = { nav.navigate("sign-out") }) }
    composable("sign-out") { SignOutScreen(model) }
  }
  Prompts(model)
}

/** A screen of rows: the scaffold's time text and scroll indicator, crown scrolling. */
@Composable
internal fun ListScreen(content: ScalingLazyListScope.() -> Unit) {
  val state = rememberScalingLazyListState()
  ScreenScaffold(scrollState = state) { padding ->
    ScalingLazyColumn(state = state, contentPadding = padding, modifier = Modifier.fillMaxWidth(), content = content)
  }
}

/**
 * One part of the player's state. The whole state changes twice a second while a book plays (the
 * position), so a screen that shows none of that reads only its part and is redrawn when it changes.
 */
@Composable
internal fun <T> playerPart(model: AppModel, part: (PlayerState) -> T): State<T> {
  val state = model.engine.state
  return remember(state) { state.map(part).distinctUntilChanged() }.collectAsState(part(state.value))
}

/** A yes or no question over a screen. */
@Composable
internal fun ConfirmDialog(visible: Boolean, title: String, text: String? = null, onConfirm: () -> Unit, onDismiss: () -> Unit) {
  AlertDialog(
    visible = visible,
    onDismissRequest = onDismiss,
    title = { Text(title) },
    text = text?.let { { Text(it) } },
    confirmButton = { AlertDialogDefaults.ConfirmButton(onClick = onConfirm) },
    dismissButton = { AlertDialogDefaults.DismissButton(onClick = onDismiss) },
  )
}

/** A row that only says what is happening. */
@Composable
internal fun Busy(label: String) {
  Button(onClick = {}, enabled = false, modifier = Modifier.fillMaxWidth(), icon = { CircularProgressIndicator() }, label = { Text(label) })
}

@Composable
internal fun Note(text: String, center: Boolean = false) {
  Text(
    text,
    style = MaterialTheme.typography.bodySmall,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
    textAlign = if (center) TextAlign.Center else null,
    modifier = Modifier.fillMaxWidth(),
  )
}

// Setup

/**
 * Not signed in: what to do on the phone (no typed sign-in, a Wear quality rule), "Get AudioSilo
 * on your phone" when no paired phone has the app (decision 12), and the books the phone sent.
 */
@Composable
fun SetupScreen(model: AppModel, status: AppModel.SetupStatus) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  var phoneHasApp by remember { mutableStateOf<Boolean?>(null) }
  var storeAnswer by remember { mutableStateOf<String?>(null) }
  LaunchedEffect(Unit) { phoneHasApp = PhoneApp.installed(context) }
  val held by model.heldBooks.collectAsState()
  ListScreen {
    item { ListHeader { Text("AudioSilo") } }
    item {
      when (status) {
        AppModel.SetupStatus.Waiting -> Text(SETUP_WAITING, modifier = Modifier.fillMaxWidth())
        AppModel.SetupStatus.SigningIn -> Busy("Signing in")
        AppModel.SetupStatus.Expired -> Text(AppModel.EXPIRED, modifier = Modifier.fillMaxWidth())
        is AppModel.SetupStatus.Failed -> Text(status.message, modifier = Modifier.fillMaxWidth())
      }
    }
    if (phoneHasApp == false && status !is AppModel.SetupStatus.SigningIn) {
      item {
        FilledTonalButton(
          onClick = { scope.launch { storeAnswer = if (PhoneApp.openStoreOnPhone(context)) OPENED_ON_PHONE else COULD_NOT_OPEN } },
          modifier = Modifier.fillMaxWidth(),
          label = { Text("Get AudioSilo on your phone") },
        )
      }
      storeAnswer?.let { item { Note(it) } }
    }
    heldRows(held)
  }
}

// Too old

/** The server lacks Sync v2 or the watch rendition (needs 2.6 or later, with ffmpeg). */
@Composable
fun TooOldScreen(model: AppModel, version: String?, onSignOut: () -> Unit) {
  val server by model.server.collectAsState()
  val pending by model.pendingReplace.collectAsState()
  val held by model.heldBooks.collectAsState()
  ListScreen {
    item { ListHeader { Text("AudioSilo") } }
    // Blocked by listening still to send, it would go unseen here (a replace stays on Home).
    pending?.let { replaceRows(model, it) }
    item { Text(tooOldMessage(server?.capabilities?.listeningSync == true), modifier = Modifier.fillMaxWidth()) }
    version?.let { item { Note("Your server: $it") } }
    item {
      Button(onClick = { model.becameActive() }, modifier = Modifier.fillMaxWidth(), label = { Text("Try again") })
    }
    item { OutlinedButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth(), label = { Text("Sign out") }) }
    // Below the buttons: many rows would push them far down a small watch.
    heldRows(held)
  }
}

@Composable
private fun TooOldNav(model: AppModel, version: String?) {
  val nav = rememberSwipeDismissableNavController()
  SwipeDismissableNavHost(navController = nav, startDestination = "too-old") {
    composable("too-old") { TooOldScreen(model, version, onSignOut = { nav.navigate("sign-out") }) }
    composable("sign-out") { SignOutScreen(model) }
  }
}

fun tooOldMessage(hasListeningSync: Boolean): String =
  if (hasListeningSync) {
    "This server can't make books for the watch. It needs ffmpeg."
  } else {
    "This server is too old for the watch app (needs 2.6 or later)."
  }

// Home

@Composable
fun HomeScreen(
  model: AppModel,
  onThisWatch: () -> Unit,
  onNowPlaying: () -> Unit,
  onPlay: (DownloadRecord) -> Unit,
  onSync: () -> Unit,
  onSignOut: () -> Unit,
) {
  val playerBook by playerPart(model) { it.book }
  val playing by playerPart(model) { it.playing }
  val pending by model.pendingReplace.collectAsState()
  val records by model.downloads.records.collectAsState()
  val held by model.heldBooks.collectAsState()
  val account by model.account.collectAsState()
  val rows by model.library.rows.collectAsState()
  val loading by model.library.loading.collectAsState()
  val problem by model.library.problem.collectAsState()
  val scope = rememberCoroutineScope()

  val coming = records.filter { it.state.onTheWay }
  val heldComing = HeldBooks.waiting(held, account?.accountId, coming.map { it.ref })
  // Less what On the way lists (a book shows once on Home; its state is there).
  val comingRefs = coming.map { it.ref }.toSet() + held.filter { it.waiting && it.book.accountId == account?.accountId }.map { it.book.ref }
  val continueRows = rows.filter { it.ref !in comingRefs }

  ListScreen {
    item { ListHeader { Text("AudioSilo") } }
    pending?.let { replaceRows(model, it) }
    playerBook?.let { book ->
      item {
        Button(
          onClick = onNowPlaying,
          modifier = Modifier.fillMaxWidth(),
          secondaryLabel = { Text(if (playing) "Playing" else "Paused") },
          label = { Text(book.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        )
      }
    }
    if (coming.isNotEmpty() || heldComing.isNotEmpty()) {
      item { ListHeader { Text("On the way") } }
      items(coming, key = { "r:" + it.ref.key }) { BookRow(model, it) }
      items(heldComing, key = { "h:" + it.id }) { HeldRow(it) }
    }
    item {
      FilledTonalButton(onClick = onThisWatch, modifier = Modifier.fillMaxWidth(), label = { Text("On this watch") })
    }
    item { ListHeader { Text("Continue listening") } }
    if (rows.isEmpty()) {
      item { Note(if (loading) "Loading" else problem.ifEmpty { "Nothing in progress" }) }
    } else {
      if (problem.isNotEmpty()) item { Note(problem) }
      items(continueRows, key = { "c:" + it.ref.key }) { row -> ContinueItem(model, row, records.firstOrNull { it.ref == row.ref }, onPlay) }
    }
    item {
      OutlinedButton(
        onClick = { scope.launch { model.client()?.let { model.library.refresh(it) } } },
        enabled = !loading,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(if (loading) "Refreshing" else "Refresh") },
      )
    }
    item { FilledTonalButton(onClick = onSync, modifier = Modifier.fillMaxWidth(), label = { Text("Sync") }) }
    item { OutlinedButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth(), label = { Text("Sign out") }) }
  }
}

/**
 * A pair message for another account: blocked while listening waits (the count is live, so once
 * it has synced the switch is one tap), switching, or why it did not happen.
 */
private fun ScalingLazyListScope.replaceRows(model: AppModel, state: AppModel.PendingReplace) {
  when (state) {
    AppModel.PendingReplace.Waiting ->
      item {
        val revision by model.syncRevision.collectAsState()
        val waiting = remember(revision) { model.outbox.unsentCount }
        var confirming by remember { mutableStateOf(false) }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (waiting > 0) {
          Note("Another account wants this watch, but ${Labels.updates(waiting)} not synced yet.")
          Button(
            onClick = { confirming = true },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.filledTonalButtonColors(),
            label = { Text("Discard and switch") },
          )
        } else {
          Note("Another account wants this watch.")
          Button(onClick = { model.replace(discard = false) }, modifier = Modifier.fillMaxWidth(), label = { Text("Switch") })
        }
        OutlinedButton(onClick = { model.keepAccount() }, modifier = Modifier.fillMaxWidth(), label = { Text("Keep this account") })
        }
        ConfirmDialog(
          visible = confirming,
          title = DISCARD_QUESTION,
          onConfirm = {
            confirming = false
            model.replace(discard = true)
          },
          onDismiss = { confirming = false },
        )
      }
    AppModel.PendingReplace.Switching -> item { Busy("Switching accounts") }
    is AppModel.PendingReplace.Failed ->
      item {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Note(state.message)
          Button(onClick = { model.keepAccount() }, modifier = Modifier.fillMaxWidth(), label = { Text("OK") })
        }
      }
  }
}

@Composable
private fun ContinueItem(model: AppModel, row: ContinueRow, record: DownloadRecord?, onPlay: (DownloadRecord) -> Unit) {
  val heard = "${(row.fraction * 100).toInt()}% heard"
  val secondary = listOfNotNull(row.author?.takeIf { it.isNotBlank() }, heard).joinToString(" · ")
  when (record?.state) {
    null,
    WatchStateBook.State.FAILED ->
      Button(
        onClick = { model.download(row) },
        modifier = Modifier.fillMaxWidth(),
        secondaryLabel = { Text(if (record == null) "Download · $secondary" else "Try again · $secondary", maxLines = 2) },
        label = { Text(row.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
      )
    WatchStateBook.State.READY ->
      Button(
        onClick = { onPlay(record) },
        modifier = Modifier.fillMaxWidth(),
        icon = { Icon(Glyphs.play, contentDescription = null) },
        secondaryLabel = { Text("Play · $secondary", maxLines = 2) },
        label = { Text(row.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
      )
    else ->
      Button(
        onClick = {},
        enabled = false,
        modifier = Modifier.fillMaxWidth(),
        secondaryLabel = { Text(Labels.state(record.state), maxLines = 1) },
        label = { Text(row.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
      )
  }
}

// On this watch

@Composable
fun OnThisWatchScreen(model: AppModel, onPlay: (DownloadRecord) -> Unit) {
  val records by model.downloads.records.collectAsState()
  val held by model.heldBooks.collectAsState()
  var removing by remember { mutableStateOf<DownloadRecord?>(null) }
  ListScreen {
    item { ListHeader { Text("On this watch") } }
    if (records.isEmpty()) {
      item { Note("No books on this watch yet. Download one from Continue listening, or send one from your phone.") }
    }
    items(records, key = { it.ref.key }) { r ->
      // A book here plays on a tap; its Remove is the button below it (a book on its way: the tap).
      if (r.state == WatchStateBook.State.READY) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
          BookRow(model, r, onClick = { onPlay(r) })
          OutlinedButton(onClick = { removing = r }, modifier = Modifier.fillMaxWidth(), label = { Text("Remove") })
        }
      } else {
        BookRow(model, r, onClick = { removing = r })
      }
    }
    if (records.any { it.state != WatchStateBook.State.READY }) item { Note("Tap a book on its way to remove it.") }
    if (held.isNotEmpty()) {
      item { ListHeader { Text("From your phone") } }
      heldRows(held)
    }
  }
  val r = removing
  ConfirmDialog(
    visible = r != null,
    title = r?.let { "Remove ${it.title}?" } ?: "",
    text = "Remove from watch",
    onConfirm = {
      r?.let { model.removeBook(it.ref) }
      removing = null
    },
    onDismiss = { removing = null },
  )
}

/** A book on the watch or on its way: its size, its progress, why it waits or failed. */
@Composable
private fun BookRow(model: AppModel, record: DownloadRecord, onClick: (() -> Unit)? = null) {
  val lines = bookRowLines(record)
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
  Button(
    onClick = onClick ?: {},
    enabled = onClick != null,
    modifier = Modifier.fillMaxWidth(),
    secondaryLabel = { Text(lines.joinToString("\n"), maxLines = 4) },
    label = { Text(record.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
  )
  // Q3: no Wi-Fi within 30 s: this book may come over the phone's connection instead.
  if (record.waitingForWifi && !record.slow && record.state.onTheWay) {
    OutlinedButton(
      onClick = { model.useSlowConnection(record.ref) },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Use the phone's connection (slow)", maxLines = 2) },
    )
  }
  }
}

/** What a book's row says under its title (the Apple Watch's BookOnWatchRow). */
fun bookRowLines(record: DownloadRecord): List<String> {
  val lines = ArrayList<String>()
  lines +=
    when (record.state) {
      WatchStateBook.State.READY -> Labels.bytes(record.bytes)
      WatchStateBook.State.DOWNLOADING -> "Downloading ${record.doneCount} of ${record.files.size} files"
      else -> Labels.state(record.state)
    }
  // Only once its files are known, and not beside a message: the server has not taken it yet.
  if (record.state == WatchStateBook.State.PREPARING && record.files.isNotEmpty() && record.message == null) lines += PREPARING_HINT
  if (record.state != WatchStateBook.State.READY) record.message?.let { lines += it }
  return lines
}

private fun ScalingLazyListScope.heldRows(held: List<HeldBook>) {
  items(held, key = { "held:" + it.id }) { HeldRow(it) }
}

/** A book the phone sent that is not on the watch: waiting until it can take it, or given up on. */
@Composable
private fun HeldRow(held: HeldBook) {
  Button(
    onClick = {},
    enabled = false,
    modifier = Modifier.fillMaxWidth(),
    secondaryLabel = { Text(heldLine(held), maxLines = 3) },
    label = { Text(held.book.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
  )
}

fun heldLine(held: HeldBook): String =
  if (held.waiting) "Waiting until this watch can take it" else "Not delivered. Send it again from your phone."

const val SETUP_WAITING = "Open AudioSilo on your phone and choose Set up your watch."

/**
 * The server's encode runs under its own lifetime, whoever is polling; on Wear the book's worker
 * goes on in the background (decision 8), so the watch can be put down.
 */
const val PREPARING_HINT = "This can take a few minutes. Your server keeps going, and the download starts by itself."

private const val OPENED_ON_PHONE = "Continue on your phone."
private const val COULD_NOT_OPEN = "Couldn't reach your phone."
