// Now Playing: the chapter and its times, play / pause, skip back 15 and forward 30, previous /
// next chapter, and the Chapters, Speed and Sleep pages. Opened with `start`, it plays that
// book (pull before play, AppModel.play).
import SwiftUI

struct NowPlayingView: View {
  @EnvironmentObject var model: AppModel
  @ObservedObject var engine: WatchAudioEngine
  var start: DownloadRecord?
  /// The book is started once, not on every return from Chapters, Speed or Sleep.
  @State private var started = false
  /// The start is over, whatever came of it: no book loaded now is not "still starting".
  @State private var startFinished = false

  var body: some View {
    ScrollView {
      VStack(spacing: 6) {
        if let book = engine.book {
          Text(engine.times?.title ?? book.title).font(.headline).lineLimit(2).multilineTextAlignment(.center)
          if engine.times?.chapterIndex != nil {
            Text(book.title).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
          }
          if let t = engine.times, t.duration > 0 {
            ProgressView(value: min(t.elapsed, t.duration), total: t.duration)
            let figures = Skips.figures(position: t.elapsed, length: t.duration)
            HStack {
              Text(Labels.clock(figures.elapsed))
              Spacer()
              Text("-" + Labels.clock(figures.left))
            }
            .font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
            if let line = Skips.wallClockLine(position: t.elapsed, total: t.duration, rate: engine.rate) {
              Text(line).font(.footnote.monospacedDigit()).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
          }
          HStack {
            Button { engine.skip(-Skips.BACK) } label: { Image(systemName: "gobackward.15") }
              .accessibilityLabel("Back 15 seconds")
            Button { engine.toggle() } label: {
              if engine.starting {
                ProgressView()
              } else {
                Image(systemName: engine.playing ? "pause.fill" : "play.fill")
              }
            }
            .accessibilityLabel(engine.playing || engine.starting ? "Pause" : "Play")
            Button { engine.skip(Skips.FORWARD) } label: { Image(systemName: "goforward.30") }
              .accessibilityLabel("Forward 30 seconds")
          }
          .buttonStyle(.bordered)
          if !book.timeline.chapters.isEmpty {
            HStack {
              Button { engine.previousChapter() } label: { Image(systemName: "backward.end.fill") }
                .accessibilityLabel("Previous chapter")
              Button { engine.nextChapter() } label: { Image(systemName: "forward.end.fill") }
                .accessibilityLabel("Next chapter")
            }
            .buttonStyle(.bordered)
          }
          if let problem = engine.problem {
            Text(problem).font(.footnote).foregroundStyle(.secondary)
          }
          if !book.timeline.chapters.isEmpty {
            NavigationLink("Chapters") { ChaptersView(engine: engine) }
          }
          NavigationLink("Speed \(PlaybackSpeed.label(engine.rate))") { SpeedView(engine: engine) }
          NavigationLink(sleepLabel) { SleepView(engine: engine) }
        } else if start != nil && !startFinished {
          ProgressView()
        } else if start != nil {
          Text("This book can't start now. Go back and try again.").font(.footnote).foregroundStyle(.secondary)
        } else {
          Text("Nothing playing").foregroundStyle(.secondary)
        }
      }
    }
    .navigationTitle("Now playing")
    .task {
      guard let start, !started else { return }
      started = true
      // Its own task: leaving the screen cancels `.task`, which would cut the pull before play
      // short (the book would still load and play, from a stale place and with no offer).
      if engine.loadedBook != start.ref || !engine.playing { await Task { await model.play(start) }.value }
      startFinished = true
    }
  }

  private var sleepLabel: String {
    guard let s = engine.sleep else { return "Sleep timer" }
    return "Sleep in \(Labels.clock(s.left(position: engine.position, rate: engine.rate)))"
  }
}

struct ChaptersView: View {
  @ObservedObject var engine: WatchAudioEngine
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    List {
      if let book = engine.book {
        let current = engine.times?.chapterIndex
        ForEach(Array(book.timeline.chapters.enumerated()), id: \.offset) { i, ch in
          Button {
            engine.seek(to: ch.bookOffset)
            dismiss()
          } label: {
            HStack {
              Text(ChapterNav.title(ch, index: i)).lineLimit(2)
              Spacer()
              if i == current { Image(systemName: "speaker.wave.2.fill").foregroundStyle(.secondary) }
            }
          }
        }
      }
    }
    .navigationTitle("Chapters")
  }
}

struct SpeedView: View {
  @ObservedObject var engine: WatchAudioEngine
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    List(PlaybackSpeed.PRESETS, id: \.self) { r in
      Button {
        engine.setRate(r)
        dismiss()
      } label: {
        HStack {
          Text(PlaybackSpeed.label(r))
          Spacer()
          if r == engine.rate { Image(systemName: "checkmark") }
        }
      }
    }
    .navigationTitle("Speed")
  }
}

struct SleepView: View {
  @ObservedObject var engine: WatchAudioEngine
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    List {
      if engine.sleep != nil {
        Button("Turn off") {
          engine.setSleep(nil)
          dismiss()
        }
      }
      ForEach(Array(SleepTimer.CHOICES.enumerated()), id: \.offset) { _, mode in
        Button(Self.label(mode)) {
          engine.setSleep(mode)
          dismiss()
        }
      }
    }
    .navigationTitle("Sleep timer")
  }

  static func label(_ mode: SleepMode) -> String {
    switch mode {
    case .minutes(let n): return "\(n) minutes"
    case .endOfChapter: return "End of chapter"
    }
  }
}
