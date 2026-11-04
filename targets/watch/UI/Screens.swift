// The watch's screens (pass 1): Setup, the "server too old" screen, Continue listening with a
// Download button per row, and On this watch (size, remove). PASS 2 adds Now Playing, Sync
// status, the offer sheet and Sign out.
import SwiftUI

struct RootView: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    switch model.phase {
    case .setup(let status): SetupView(status: status)
    case .tooOld(let version): TooOldView(version: version)
    case .ready: HomeView()
    }
  }
}

struct SetupView: View {
  @EnvironmentObject var model: AppModel
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
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

struct TooOldView: View {
  @EnvironmentObject var model: AppModel
  let version: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text("This server is too old for the watch app (needs 2.6 or later).")
        if let version { Text("Your server: \(version)").font(.footnote).foregroundStyle(.secondary) }
        Button("Try again") { Task { await model.checkServer(); model.becameActive() } }
      }
    }
  }
}

struct HomeView: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    NavigationStack {
      List {
        if let blocked = model.replaceBlocked {
          Text("\(blocked) listening not synced yet. Connect to your server before switching accounts.")
            .font(.footnote)
        }
        Section("Continue listening") {
          ContinueSection(library: model.library, downloads: model.downloads)
        }
        Section {
          NavigationLink("On this watch") { OnThisWatchView(downloads: model.downloads) }
        }
      }
      .navigationTitle("AudioSilo")
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
      Label("On this watch", systemImage: "checkmark.circle").font(.footnote)
    case let state?:
      Text(Labels.state(state)).font(.footnote).foregroundStyle(.secondary)
    }
  }
}

struct OnThisWatchView: View {
  @ObservedObject var downloads: DownloadManager
  @State private var removing: DownloadRecord?

  var body: some View {
    List {
      if downloads.records.isEmpty {
        Text("No books on this watch yet. Download one from Continue listening, or send one from your iPhone.")
          .font(.footnote).foregroundStyle(.secondary)
      }
      ForEach(downloads.records) { r in
        Button { removing = r } label: { BookOnWatchRow(record: r, downloads: downloads) }
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
  @ObservedObject var downloads: DownloadManager

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(record.title).lineLimit(2)
      switch record.state {
      case .ready:
        Text(Labels.bytes(downloads.size(record))).font(.footnote).foregroundStyle(.secondary)
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

  static func bytes(_ n: Int64) -> String { ByteCountFormatter.string(fromByteCount: n, countStyle: .file) }
}
