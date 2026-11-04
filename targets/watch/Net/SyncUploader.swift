// Sending the outbox (Sync v2). In the foreground `Outbox.flush` posts through `APIClient`
// (the transport below). In the background (decision 10) one snapshot of the outbox, built with
// `clock_offset` instead of `sent_at`, goes to a background URLSession upload: the system sends
// it when a network appears, without the app open, and its answer arrives on a later wake,
// where it is applied like a foreground one (`Outbox.applyBackground`). Replays are safe: the
// event ids are the idempotency keys. One upload at a time: a newer snapshot cancels the older.
import Foundation

/// A finished background upload, for the main actor.
struct SyncUploadAnswer {
  var tag: SyncUploadTag
  var outcome: BackgroundSync.Outcome
}

final class SyncUploader: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  static let shared = SyncUploader()
  static let identifier = (Bundle.main.bundleIdentifier ?? "app.audiosilo.watchkitapp") + ".sync"

  /// Told of every finished upload, on the main queue (answers that came before it was set wait).
  var handler: ((SyncUploadAnswer) -> Void)? {
    didSet { deliverWaiting() }
  }

  private let lock = NSLock()
  private var bodies: [Int: Data] = [:]
  private var waiting: [SyncUploadAnswer] = []
  private var wakeDone: (() -> Void)?
  private var finishedEarly = false

  private lazy var session: URLSession = {
    let c = URLSessionConfiguration.background(withIdentifier: Self.identifier)
    c.isDiscretionary = false
    c.sessionSendsLaunchEvents = true
    c.allowsExpensiveNetworkAccess = true
    c.allowsConstrainedNetworkAccess = true
    return URLSession(configuration: c, delegate: self, delegateQueue: nil)
  }()

  /// Reconnect at launch, so an upload a previous launch started reports here.
  func attach() { _ = session }

  /// Hand `body` to the system for `api`'s server, replacing any upload not yet answered.
  func enqueue(_ body: SyncRequest, api: APIClient, accountId: String) {
    guard let tagText = BackgroundSync.describe(SyncUploadTag(accountId: accountId, ids: body.events.map(\.id))),
      let data = try? Wire.encoder.encode(body),
      var request = try? api.request("POST", "/me/listening/sync")
    else { return }
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    // A background upload goes from a file; each snapshot has its own (the system copies it).
    let file = Files.root.appendingPathComponent("sync-upload-\(UUID().uuidString).json")
    guard (try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])) != nil else {
      return
    }
    session.getAllTasks { tasks in
      for t in tasks { t.cancel() }
      let task = self.session.uploadTask(with: request, fromFile: file)
      task.taskDescription = tagText
      task.countOfBytesClientExpectsToSend = Int64(data.count)
      task.countOfBytesClientExpectsToReceive = 64 * 1024
      task.resume()
      Self.removeOldBodies(keeping: file)
    }
  }

  /// Forget any upload (signed out).
  func cancelAll() {
    session.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
    Self.removeOldBodies(keeping: nil)
  }

  /// A background wake for this session: resolves once the system's events are delivered.
  func wake() async {
    attach()
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      lock.lock()
      if finishedEarly {
        finishedEarly = false
        lock.unlock()
        c.resume()
        return
      }
      wakeDone = { c.resume() }
      lock.unlock()
    }
  }

  private static func removeOldBodies(keeping: URL?) {
    let fm = FileManager.default
    let names = (try? fm.contentsOfDirectory(atPath: Files.root.path)) ?? []
    for n in names where n.hasPrefix("sync-upload-") && n != keeping?.lastPathComponent {
      try? fm.removeItem(at: Files.root.appendingPathComponent(n))
    }
  }

  private func deliverWaiting() {
    DispatchQueue.main.async {
      guard let handler = self.handler else { return }
      self.lock.lock()
      let ready = self.waiting
      self.waiting = []
      self.lock.unlock()
      ready.forEach(handler)
    }
  }

  // MARK: - URLSessionDataDelegate

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.lock()
    bodies[dataTask.taskIdentifier, default: Data()].append(data)
    lock.unlock()
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.lock()
    let body = bodies.removeValue(forKey: task.taskIdentifier)
    lock.unlock()
    if (error as? URLError)?.code == .cancelled { return }
    guard let tag = BackgroundSync.tag(task.taskDescription) else { return }
    let status = error == nil ? (task.response as? HTTPURLResponse)?.statusCode : nil
    let answer = SyncUploadAnswer(tag: tag, outcome: BackgroundSync.outcome(status: status, body: body))
    lock.lock()
    waiting.append(answer)
    lock.unlock()
    deliverWaiting()
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    lock.lock()
    let done = wakeDone
    wakeDone = nil
    if done == nil { finishedEarly = true }
    lock.unlock()
    // Let the answers reach the main actor first.
    DispatchQueue.main.async { done?() }
  }
}
