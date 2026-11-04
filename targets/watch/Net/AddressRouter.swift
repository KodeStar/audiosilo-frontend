// Which of the account's addresses the watch uses now (the phone's address runner, cut down):
// re-picked at launch, on coming to the foreground and every 90 s while in it. Home only after
// a tokenless probe answered this server's id (AddressPicker); else away; else the paired URL.
import Foundation

@MainActor
final class AddressRouter: ObservableObject {
  /// How often home is asked again in the foreground.
  static let HOME_RECHECK: TimeInterval = 90

  @Published private(set) var current: String?
  private var generation = 0
  private var timer: Timer?

  /// The address for `account` now: the pick while it is still one of its own, else the paired URL.
  func base(for account: Account) -> String {
    if let c = current, AddressPicker.isOwn(c, serverURL: account.serverURL, addresses: account.addresses) { return c }
    return account.serverURL
  }

  /// Start on the address the sign-in answered at (already proven: the exchange checked it).
  func start(at url: String?) {
    current = url
  }

  func repick(_ account: Account) async {
    generation += 1
    let mine = generation
    let url = await AddressPicker.pick(serverURL: account.serverURL, addresses: account.addresses,
                                       serverId: account.serverId, probe: APIClient.probeServerId)
    guard mine == generation else { return }
    current = url
  }

  /// Ask home again every `HOME_RECHECK` while in the foreground (walking in the door raises no event).
  func startRechecks(_ account: @escaping () -> Account?) {
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: Self.HOME_RECHECK, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self, let a = account(), a.addresses?.home != nil else { return }
        await self.repick(a)
      }
    }
  }

  func stopRechecks() {
    timer?.invalidate()
    timer = nil
  }

  /// Going to the background: the watch may join another network before it is back, where
  /// another box can hold the same private address, so a home pick is dropped until the next
  /// probe proves it again (the token never goes to a home address checked elsewhere).
  func leaveHome(_ account: Account) {
    guard let c = current, let home = account.addresses?.home, AddressPicker.sameURL(c, home) else { return }
    generation += 1
    current = AddressPicker.fallback(serverURL: account.serverURL, addresses: account.addresses)
  }

  /// Signed out: no pick.
  func reset() {
    generation += 1
    current = nil
  }
}
