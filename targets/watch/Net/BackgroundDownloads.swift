// The background URLSession that downloads rendition files (decision 6): the system carries
// on while the app is suspended and wakes it when they finish (`backgroundTask(.urlSession)`,
// W0 check 2: 300 MB in about 8 minutes standalone). Auth is a header (Bearer, never
// `?token=`). A transfer that fails with resume data is resumed from it (the system sends the
// Range / If-Range for the bytes it has) while the address and token are still the same; else it
// starts again. A task that got a 503 or 422 still "finishes", with
// the JSON error as its file, so the status is checked in `didFinishDownloadingTo`.
//
// While suspended, a task begun at the home address goes on there with its token, on whatever
// network the system finds: cancelled and started again when the app next sees the pick has left
// home (`RenditionPlan.keepsTransfer`, DownloadManager), not before.
//
// One delegate for the app's one background session; the DownloadManager sets `handler`.
import Foundation

/// Which book file a task downloads (its `taskDescription`).
struct DownloadTaskTag: Codable, Equatable {
  var book: String
  var path: String

  /// `book|path`: one file of one book.
  var key: String { "\(book)|\(path)" }
}

/// What a finished task brought.
enum DownloadEvent {
  /// The file, moved out of the system's temporary location to `staged`.
  case finished(DownloadTaskTag, staged: URL)
  /// The server refused (the status was not 200/206).
  case refused(DownloadTaskTag, APIError)
  /// No answer, or the transfer broke; `resumeData` resumes it.
  case failed(DownloadTaskTag, resumeData: Data?)
  /// Bytes came in: this share of the file is here (0...1). Only while the app runs: a suspended
  /// app hears of a file when it lands.
  case progress(DownloadTaskTag, fraction: Double)
}

final class BackgroundDownloads: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  static let shared = BackgroundDownloads()
  static let identifier = BackgroundSession.identifier(".downloads")

  /// Told of every event, on the main queue.
  var handler: ((DownloadEvent) -> Void)?
  private let backgroundWake = BackgroundWake()
  /// The share last told per task (by `taskIdentifier`), so a file's progress is told in steps of
  /// `PROGRESS_STEP`, not per chunk. Guarded by `lock`.
  private var told: [Int: Double] = [:]
  private let lock = NSLock()
  private static let PROGRESS_STEP = 0.01

  private lazy var session: URLSession = URLSession(configuration: BackgroundSession.configuration(Self.identifier), delegate: self,
                                        delegateQueue: nil)

  /// Reconnect to the session at launch, so a previous launch's events arrive.
  func attach() { _ = session }

  /// Start (or resume) one file's download.
  func start(_ request: URLRequest, tag: DownloadTaskTag, expectedBytes: Int64?, resumeData: Data?) {
    let task = resumeData.flatMap { resumed($0, sending: request) } ?? session.downloadTask(with: request)
    task.taskDescription = BackgroundSync.describe(tag)
    if let b = expectedBytes, b > 0 { task.countOfBytesClientExpectsToReceive = b }
    task.resume()
  }

  /// A task from resume data only when it sends what `request` does. Resume data replays its
  /// own request: a transfer begun at the home address would go on there from another network
  /// (CROSS-REPO section 7: the token only to a home address proved on this one), or with a
  /// token since replaced. Else it is cancelled untagged (the delegate ignores it).
  private func resumed(_ data: Data, sending request: URLRequest) -> URLSessionDownloadTask? {
    let task = session.downloadTask(withResumeData: data)
    let auth = "Authorization"
    if let was = task.originalRequest, was.url == request.url,
       was.value(forHTTPHeaderField: auth) == request.value(forHTTPHeaderField: auth)
    {
      return task
    }
    task.cancel()
    return nil
  }

  /// The transfers going on, by `DownloadTaskTag.key` (one being cancelled no longer is one).
  func inFlight() async -> [String: URLSessionTask] {
    var going: [String: URLSessionTask] = [:]
    for task in await session.allTasks where task.state == .running || task.state == .suspended {
      if let tag = Self.tag(task) { going[tag.key] = task }
    }
    return going
  }

  /// Cancel every task of a book.
  func cancel(book: String) {
    session.getAllTasks { tasks in
      for t in tasks where Self.tag(t)?.book == book { t.cancel() }
    }
  }

  /// A background wake for this session: resolves once the system's events are delivered.
  func wake() async {
    attach()
    await backgroundWake.wait()
  }

  private static func tag(_ task: URLSessionTask) -> DownloadTaskTag? {
    BackgroundSync.tag(task.taskDescription, as: DownloadTaskTag.self)
  }

  private func emit(_ e: DownloadEvent) {
    DispatchQueue.main.async { self.handler?(e) }
  }

  // MARK: - URLSessionDownloadDelegate

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    guard let tag = Self.tag(downloadTask) else { return }
    let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? -1
    guard RenditionPlan.downloadSucceeded(status: status) else {
      let retry = (downloadTask.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After")
      emit(.refused(tag, APIError(status: status, body: try? Data(contentsOf: location), retryAfterHeader: retry)))
      return
    }
    // The system deletes `location` when this returns: move it now.
    try? FileManager.default.createDirectory(at: Files.staging, withIntermediateDirectories: true)
    let staged = Files.staging.appendingPathComponent(UUID().uuidString + ".m4a")
    do {
      try FileManager.default.moveItem(at: location, to: staged)
      emit(.finished(tag, staged: staged))
    } catch {
      emit(.failed(tag, resumeData: nil))
    }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                  totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64)
  {
    guard let tag = Self.tag(downloadTask) else { return }
    let expected = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : downloadTask.countOfBytesClientExpectsToReceive
    let fraction = DownloadProgress.fraction(received: totalBytesWritten, expected: expected)
    let due = lock.withLock {
      guard fraction - (told[downloadTask.taskIdentifier] ?? -1) >= Self.PROGRESS_STEP else { return false }
      told[downloadTask.taskIdentifier] = fraction
      return true
    }
    if due { emit(.progress(tag, fraction: fraction)) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.withLock { told[task.taskIdentifier] = nil }
    guard let error, let tag = Self.tag(task) else { return }
    if (error as? URLError)?.code == .cancelled, (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] == nil {
      return  // removed by hand
    }
    emit(.failed(tag, resumeData: (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data))
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    backgroundWake.finished()
  }
}
