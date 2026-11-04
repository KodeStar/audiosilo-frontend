// Sync status (last sync, waiting, couldn't sync, the address in use, the server's version)
// and Sign out, blocked while listening waits unless the listener discards it (decision 9).
import SwiftUI

struct SyncStatusView: View {
  @EnvironmentObject var model: AppModel
  /// Observed so the address shown follows the router's pick.
  @ObservedObject var router: AddressRouter

  var body: some View {
    let _ = model.syncRevision
    let failed = model.outbox.couldNotSync()
    List {
      Section {
        LabeledContent("Last sync", value: model.outbox.state.lastSyncAt.map(Labels.ago) ?? "Not yet")
        LabeledContent("Waiting", value: "\(model.outbox.unsentCount)")
        if model.outbox.lastFlushFailed {
          Text("Can't reach your server. Listening is kept here and sent when it can be.")
            .font(.footnote).foregroundStyle(.secondary)
        }
        SyncNowButton()
      }
      if !failed.isEmpty {
        Section("Couldn't sync") {
          ForEach(failed, id: \.event.id) { f in
            VStack(alignment: .leading, spacing: 2) {
              Text(Labels.reason(f.reason)).font(.footnote)
              Text(Labels.ago(f.at)).font(.footnote).foregroundStyle(.secondary)
            }
            .swipeActions {
              Button(role: .destructive) { model.outbox.discardFailed(f.event.id) } label: {
                Label("Dismiss", systemImage: "xmark")
              }
            }
          }
        }
      }
      Section("Server") {
        if let a = model.account {
          LabeledContent("Name", value: a.serverName)
          LabeledContent("Address", value: router.base(for: a))
        }
        LabeledContent("Version", value: model.server?.version ?? "Unknown")
      }
    }
    .navigationTitle("Sync")
  }
}

/// Sends what waits now (shown where listening waits: Sync status, Sign out, a blocked replace).
struct SyncNowButton: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    let _ = model.syncRevision
    Button(model.syncing ? "Syncing" : "Sync now") { Task { await model.flush() } }
      .disabled(model.syncing || model.outbox.unsentCount == 0)
  }
}

struct SignOutView: View {
  @EnvironmentObject var model: AppModel
  @State private var confirmDiscard = false

  var body: some View {
    let _ = model.syncRevision
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        if let a = model.account {
          Text("Signed in as \(a.userName) on \(a.serverName).").font(.footnote)
        }
        let waiting = model.outbox.unsentCount
        if waiting > 0 {
          Text("\(Labels.updates(waiting)) not synced yet. Sync first, or discard to sign out.")
            .font(.footnote).foregroundStyle(.secondary)
          SyncNowButton()
          Button("Discard and sign out", role: .destructive) { confirmDiscard = true }
        } else {
          // Blocked (stopping the player closed a span), the count above takes over at once.
          Button("Sign out", role: .destructive) { model.signOut(discard: false) }
        }
        Text("Signing out removes the books on this watch.").font(.footnote).foregroundStyle(.secondary)
      }
    }
    .navigationTitle("Sign out")
    .confirmationDialog("Discard listening not synced yet?", isPresented: $confirmDiscard) {
      Button("Discard and sign out", role: .destructive) { model.signOut(discard: true) }
      Button("Cancel", role: .cancel) {}
    }
  }
}

extension Labels {
  static func ago(_ date: Date) -> String {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .short
    return f.localizedString(for: date, relativeTo: Date())
  }

  /// A couldn't-sync reason in plain words.
  static func reason(_ r: String) -> String {
    switch r {
    case "too_old": return "Too old to sync (over 89 days)"
    case "too_large": return "Too large to send"
    case "no_access": return "The book is no longer yours to sync"
    case "not_found": return "The book is no longer on the server"
    case "duration_mismatch": return "The book has changed on the server"
    default: return "The server refused it (\(r))"
    }
  }
}
