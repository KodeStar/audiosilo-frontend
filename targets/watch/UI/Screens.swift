// The watch's screens: Setup, the "server too old" screen, Home (Now playing, Continue
// listening with a Download button per row, On this watch, Sync, Sign out), and On this watch
// (play, size, remove). Now Playing is NowPlaying.swift; Sync status and Sign out are
// SyncAndAccount.swift. The offer sheet and the speaker question sit on the root, so they show
// over any screen.
import SwiftUI

struct RootView: View {
  @EnvironmentObject var model: AppModel
  @ObservedObject var engine: WatchAudioEngine

  /// One sheet at a time, offer first: a second `.sheet` is dropped while the first is up.
  private enum Prompt: Identifiable {
    case offer(OfferPrompt)
    case speaker

    var id: String {
      switch self {
      case .offer(let p): return p.id
      case .speaker: return "speaker"
      }
    }
  }

  private var prompt: Binding<Prompt?> {
    Binding(
      get: { model.offerPrompt.map(Prompt.offer) ?? (engine.speakerPrompt ? .speaker : nil) },
      set: { next in
        guard next == nil else { return }
        if model.offerPrompt != nil { model.offerPrompt = nil } else { engine.speakerPrompt = false }
      })
  }

  var body: some View {
    Group {
      switch model.phase {
      case .setup(let status): SetupView(status: status)
      case .tooOld(let version): TooOldView(version: version)
      case .ready: HomeView(engine: engine)
      }
    }
    .sheet(item: prompt) { p in
      switch p {
      case .offer(let offer): OfferSheet(prompt: offer)
      case .speaker: SpeakerSheet(engine: engine)
      }
    }
  }
}

struct SetupView: View {
  let status: AppModel.SetupStatus

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text("AudioSilo").font(.headline)
        switch status {
        case .waiting:
          Text("Open AudioSilo on your iPhone and choose Set up Apple Watch.")
        case .signingIn:
          HStack {
            ProgressView()
            Text("Signing in")
          }
        case .expired:
          Text("That sign-in has expired. Send again from your iPhone.")
        case .failed(let message):
          Text(message)
        }
        HeldBookRows()
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

struct TooOldView: View {
  @EnvironmentObject var model: AppModel
  let version: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          // Blocked by listening still to send, it would go unseen here (a replace stays on Home).
          if let pending = model.pendingReplace { ReplaceSection(state: pending) }
          if model.server?.capabilities?.listeningSync == true {
            Text("This server can't make books for the watch. It needs ffmpeg.")
          } else {
            Text("This server is too old for the watch app (needs 2.6 or later).")
          }
          if let version { Text("Your server: \(version)").font(.footnote).foregroundStyle(.secondary) }
          Button("Try again") { model.becameActive() }
          NavigationLink("Sign out") { SignOutView() }
          // Below the buttons: up to 40 rows would push them far down a small watch.
          HeldBookRows()
        }
      }
    }
  }
}

struct HomeView: View {
  @EnvironmentObject var model: AppModel
  @ObservedObject var engine: WatchAudioEngine

  var body: some View {
    NavigationStack {
      List {
        if let pending = model.pendingReplace { ReplaceSection(state: pending) }
        if let book = engine.book {
          Section("Now playing") {
            NavigationLink { NowPlayingView(engine: engine) } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(book.title).lineLimit(2)
                Text(engine.playing ? "Playing" : "Paused").font(.footnote).foregroundStyle(.secondary)
              }
            }
          }
        }
        Section("Continue listening") {
          ContinueSection(library: model.library, downloads: model.downloads)
        }
        Section {
          NavigationLink("On this watch") { OnThisWatchView(downloads: model.downloads, engine: engine) }
          NavigationLink("Sync") { SyncStatusView(router: model.router) }
          NavigationLink("Sign out") { SignOutView() }
        }
      }
      .navigationTitle("AudioSilo")
    }
  }
}

/// A pair message for another account (decision 9): blocked while listening waits (the count
/// is live, so once it has synced the switch is one tap), switching, or why it did not happen.
struct ReplaceSection: View {
  @EnvironmentObject var model: AppModel
  let state: AppModel.PendingReplace
  @State private var confirming = false

  var body: some View {
    let _ = model.syncRevision
    let waiting = model.outbox.unsentCount
    Section {
      switch state {
      case .waiting where waiting > 0:
        Text("Another account wants this watch, but \(Labels.updates(waiting)) not synced yet.")
          .font(.footnote)
        SyncNowButton()
        Button("Discard and switch", role: .destructive) { confirming = true }
        Button("Keep this account") { model.keepAccount() }
      case .waiting:
        Text("Another account wants this watch.").font(.footnote)
        Button("Switch") { model.replace(discard: false) }
        Button("Keep this account") { model.keepAccount() }
      case .switching:
        HStack {
          ProgressView()
          Text("Switching accounts")
        }
      case .failed(let message):
        Text(message).font(.footnote)
        Button("OK") { model.keepAccount() }
      }
    }
    .confirmationDialog("Discard listening not synced yet?", isPresented: $confirming) {
      Button("Discard and switch", role: .destructive) { model.replace(discard: true) }
      Button("Cancel", role: .cancel) {}
    }
  }
}

struct ContinueSection: View {
  @EnvironmentObject var model: AppModel
  @ObservedObject var library: ContinueListening
  @ObservedObject var downloads: DownloadManager

  var body: some View {
    if library.rows.isEmpty {
      Text(library.loading ? "Loading" : (library.problem.isEmpty ? "Nothing in progress" : library.problem))
        .font(.footnote).foregroundStyle(.secondary)
    } else {
      if !library.problem.isEmpty {
        Text(library.problem).font(.footnote).foregroundStyle(.secondary)
      }
      ForEach(library.rows) { row in
        VStack(alignment: .leading, spacing: 4) {
          Text(row.title).font(.body).lineLimit(2)
          if let author = row.author, !author.isEmpty {
            Text(author).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
          }
          Text("\(Int(row.fraction * 100))% heard").font(.footnote).foregroundStyle(.secondary)
          DownloadButton(row: row, record: downloads.record(row.ref))
        }
      }
    }
    Button(library.loading ? "Refreshing" : "Refresh") {
      guard let api = model.client() else { return }
      Task { await library.refresh(api) }
    }
    .disabled(library.loading)
  }
}

struct DownloadButton: View {
  @EnvironmentObject var model: AppModel
  let row: ContinueRow
  let record: DownloadRecord?

  var body: some View {
    switch record?.state {
    case nil, .failed?:
      Button(record == nil ? "Download" : "Try again") {
        model.downloads.enqueue(row.ref, title: row.title, author: row.author)
      }
    case .ready?:
      if let record {
        NavigationLink { NowPlayingView(engine: model.engine, start: record) } label: {
          Label("Play", systemImage: "play.fill")
        }
      }
    case let state?:
      Text(Labels.state(state)).font(.footnote).foregroundStyle(.secondary)
    }
  }
}

struct OnThisWatchView: View {
  @EnvironmentObject var model: AppModel
  @ObservedObject var downloads: DownloadManager
  @ObservedObject var engine: WatchAudioEngine
  @State private var removing: DownloadRecord?

  var body: some View {
    List {
      if downloads.records.isEmpty {
        Text("No books on this watch yet. Download one from Continue listening, or send one from your iPhone.")
          .font(.footnote).foregroundStyle(.secondary)
      }
      ForEach(downloads.records) { r in
        Group {
          if r.state == .ready {
            NavigationLink { NowPlayingView(engine: engine, start: r) } label: {
              BookOnWatchRow(record: r)
            }
          } else {
            Button { removing = r } label: { BookOnWatchRow(record: r) }
          }
        }
        .swipeActions {
          Button(role: .destructive) { removing = r } label: { Label("Remove", systemImage: "trash") }
        }
      }
      if !downloads.records.isEmpty {
        Text("Swipe a book to remove it.").font(.footnote).foregroundStyle(.secondary)
      }
      if !model.heldBooks.isEmpty {
        Section("From your iPhone") { HeldBookRows() }
      }
    }
    .navigationTitle("On this watch")
    .confirmationDialog(removing.map { "Remove \($0.title)?" } ?? "", isPresented: Binding(
      get: { removing != nil }, set: { if !$0 { removing = nil } })) {
      Button("Remove from watch", role: .destructive) {
        if let r = removing { downloads.remove(r.ref) }
        removing = nil
      }
      Button("Cancel", role: .cancel) { removing = nil }
    }
  }
}

struct BookOnWatchRow: View {
  let record: DownloadRecord

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(record.title).lineLimit(2)
      switch record.state {
      case .ready:
        Text(Labels.bytes(record.bytes)).font(.footnote).foregroundStyle(.secondary)
      case .downloading:
        Text("Downloading \(record.doneCount) of \(record.files.count) files").font(.footnote).foregroundStyle(.secondary)
      default:
        Text(Labels.state(record.state)).font(.footnote).foregroundStyle(.secondary)
      }
      if let message = record.message, record.state != .ready {
        Text(message).font(.footnote).foregroundStyle(.secondary)
      }
    }
  }
}

/// Books the phone sent that are not on the watch: waiting until it can take them, or given up on
/// (Core/HeldBooks.swift). Shown for every account: `watch-state` can only name the signed-in one's.
struct HeldBookRows: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    ForEach(model.heldBooks) { held in
      VStack(alignment: .leading, spacing: 3) {
        Text(held.book.title).lineLimit(2)
        Text(held.waiting ? "Waiting until this watch can take it" : "Not delivered. Send it again from your iPhone.")
          .font(.footnote).foregroundStyle(.secondary)
      }
    }
  }
}

/// Another device is somewhere else in the playing book: go there, or keep this place.
struct OfferSheet: View {
  @EnvironmentObject var model: AppModel
  let prompt: OfferPrompt

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        let who = prompt.offer.deviceName.isEmpty ? "Another device" : prompt.offer.deviceName
        Text("\(who) is at \(Labels.clock(prompt.offer.position)).")
        Text("You are at \(Labels.clock(model.engine.position)).").font(.footnote).foregroundStyle(.secondary)
        Button("Jump there") { model.jump(prompt) }
        Button("Stay here") { model.stay(prompt) }
      }
    }
    // Swiped away unanswered: not offered again on the next launch either.
    .onDisappear { model.ignore(prompt) }
  }
}

/// Decision 11: the watch's own speaker, said yes to once.
struct SpeakerSheet: View {
  @ObservedObject var engine: WatchAudioEngine

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text("Play on the watch speaker?")
        Text("Others nearby will hear it. Connect headphones to listen privately.")
          .font(.footnote).foregroundStyle(.secondary)
        Button("Play on speaker") { engine.confirmSpeaker() }
        Button("Not now", role: .cancel) { engine.speakerPrompt = false }
      }
    }
    // Closing the sheet declines, however it is closed.
    .onDisappear { if !engine.playing { engine.declineSpeaker() } }
  }
}

enum Labels {
  static func state(_ s: WatchStateBook.State) -> String {
    switch s {
    case .queued: return "Waiting to download"
    case .preparing: return "Preparing on the server"
    case .downloading: return "Downloading"
    case .ready: return "On this watch"
    case .failed: return "Couldn't download"
    }
  }

  /// "1 listening update has", "2 listening updates have".
  static func updates(_ n: Int) -> String {
    n == 1 ? "1 listening update has" : "\(n) listening updates have"
  }

  static func bytes(_ n: Int64) -> String { ByteCountFormatter.string(fromByteCount: n, countStyle: .file) }

  /// Seconds as "1:02:03" or "2:03".
  static func clock(_ seconds: Double) -> String {
    let s = Int(max(0, seconds.isFinite ? seconds : 0))
    let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
  }
}
