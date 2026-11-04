// The background URLSession that downloads rendition files (decision 6): the system carries
// on while the app is suspended and wakes it when they finish (`backgroundTask(.urlSession)`,
// W0 check 2: 300 MB in about 8 minutes standalone). Auth is a header (Bearer, never
// `?token=`). A transfer that fails with resume data is resumed from it (the system sends the
// Range / If-Range for the bytes it has). A task that got a 503 or 422 still "finishes", with
// the JSON error as its file, so the status is checked in `didFinishDownloadingTo`.
//
// One delegate for the app's one background session; the DownloadManager sets `handler`.
import Foundation

/// Which book file a task downloads (its `taskDescription`).
struct DownloadTaskTag: Codable, Equatable {
  var book: String
  var path: String
}

/// What a finished task brought.
enum DownloadEvent {
  /// The file, moved out of the system's temporary location to `staged`.
  case finished(DownloadTaskTag, staged: URL)
  /// The server refused (the status was not 200/206).
  case refused(DownloadTaskTag, APIError)
  /// No answer, or the transfer broke; `resumeData` resumes it.
  case failed(DownloadTaskTag, resumeData: Data?)
  case progress(DownloadTaskTag, written: Int64, expected: Int64)
}

final class BackgroundDownloads: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  static let shared = BackgroundDownloads()
  static let identifier = (Bundle.main.bundleIdentifier ?? "app.audiosilo.watchkitapp") + ".downloads"

  /// Told of every event, on the main queue.
  var handler: ((DownloadEvent) -> Void)?
  /// The system's completion for a background wake (`urlSessionDidFinishEvents`).
  private var wakeDone: (() -> Void)?
  /// The events were delivered before `wake` waited for them.
  private var finishedEarly = false
  private let lock = NSLock()

  private lazy var session: URLSession = {
    let c = URLSessionConfiguration.background(withIdentifier: Self.identifier)
    c.isDiscretionary = false
    c.sessionSendsLaunchEvents = true
    c.allowsExpensiveNetworkAccess = true
    c.allowsConstrainedNetworkAccess = true
    return URLSession(configuration: c, delegate: self, delegateQueue: nil)
  }()

  /// Reconnect to the session at launch, so a previous launch's events arrive.
  func attach() { _ = session }

  /// Start (or resume) one file's download.
  func start(_ request: URLRequest, tag: DownloadTaskTag, expectedBytes: Int64?, resumeData: Data?) {
    let task = resumeData.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: request)
    task.taskDescription = (try? String(data: JSONEncoder().encode(tag), encoding: .utf8)) ?? nil
    if let b = expectedBytes, b > 0 { task.countOfBytesClientExpectsToReceive = b }
    task.resume()
  }

  /// The files in flight, by tag.
  func inFlight() async -> [DownloadTaskTag] {
    await session.allTasks.compactMap(Self.tag)
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

  private static func tag(_ task: URLSessionTask) -> DownloadTaskTag? {
    guard let d = task.taskDescription?.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(DownloadTaskTag.self, from: d)
  }

  private func emit(_ e: DownloadEvent) {
    DispatchQueue.main.async { self.handler?(e) }
  }

  // MARK: - URLSessionDownloadDelegate

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    guard let tag = Self.tag(downloadTask) else { return }
    let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? -1
    guard RenditionPlan.downloadSucceeded(status: status) else {
      let body = try? Data(contentsOf: location)
      let parsed = body.flatMap { try? Wire.decoder.decode(APIErrorBody.self, from: $0) }
      let retry = (downloadTask.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
      emit(.refused(tag, APIError(status: status, code: parsed?.code, message: parsed?.error, retryAfter: retry)))
      return
    }
    // The system deletes `location` when this returns: move it now.
    let staging = Files.downloads.appendingPathComponent(".staging", isDirectory: true)
    try? FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
    let staged = staging.appendingPathComponent(UUID().uuidString + ".m4a")
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
    emit(.progress(tag, written: totalBytesWritten, expected: totalBytesExpectedToWrite))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let error, let tag = Self.tag(task) else { return }
    if (error as? URLError)?.code == .cancelled, (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] == nil {
      return  // removed by hand
    }
    emit(.failed(tag, resumeData: (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data))
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    lock.lock()
    let done = wakeDone
    wakeDone = nil
    if done == nil { finishedEarly = true }
    lock.unlock()
    DispatchQueue.main.async { done?() }
  }
}
