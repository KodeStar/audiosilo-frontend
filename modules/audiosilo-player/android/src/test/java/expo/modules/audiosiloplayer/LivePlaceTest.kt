package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LivePlaceTest {
  private val labels = CarLabels("", "", "", "", "")

  private fun ref(path: String) = BookRef("s.u", 2, path)

  /** A downloaded book of two files, its spec starting at file 0, 30 s (where JS last wrote,
   * at [savedAt]: null when the snapshot does not say). */
  private fun item(path: String, downloaded: Boolean = true, savedAt: Long? = null): CarItem {
    val book = ref(path)
    val tracks = listOf(1, 2).map {
      TrackSpec("2:$path/$it.mp3", "file:///d/$path/$it.mp3", path, null, null, null, 100.0)
    }
    val play = if (downloaded) CarPlaySpec(book, tracks, emptyList(), 0, 30.0, 1.0, savedAt) else null
    return CarItem("book:$path", path, "", null, finished = false, downloaded = downloaded, artwork = null, play = play, book = book)
  }

  private fun snapshot(resume: String?, namesResume: Boolean = true, savedAt: Long? = null) = CarSnapshot(
    labels,
    signedIn = true,
    tabs = listOf(
      CarTab("continue", "Continue", listOf(item("A", savedAt = savedAt), item("Streamed", downloaded = false))),
      CarTab("downloads", "Downloads", listOf(item("A", savedAt = savedAt), item("B"))),
    ),
    resume = resume,
    namesResume = namesResume,
  )

  private fun live(path: String, file: Int = 2, at: Double = 81.5, savedAt: Long = 1_000L) =
    LivePlace(ref(path), "$path/$file.mp3", 0, at, savedAt)

  // ---- The later place wins (FE-13) --------------------------------------------------------

  // A car-seen phone: a dead process left A at 81.5 s; JS booted with an empty engine and
  // wrote A's newer place (another device's listen) into the snapshot. That one resumes.
  @Test fun aNewerSnapshotPlaceBeatsAnOlderLivePlace() {
    val item = snapshot("book:A", savedAt = 2_000L).resumable(live("A", savedAt = 1_000L))
    assertEquals("book:A", item?.id)
    assertEquals(0, item?.play?.startIndex)
    assertEquals(30.0, item!!.play!!.positionInTrack, 0.0)
    // A car tap on the book starts there too.
    val spec = item("A", savedAt = 2_000L).play!!
    assertEquals(spec, spec.at(live("A", savedAt = 1_000L)))
  }

  @Test fun aNewerLivePlaceBeatsAnOlderSnapshotPlace() {
    val play = snapshot("book:A", savedAt = 1_000L).resumable(live("A", savedAt = 2_000L))?.play
    assertEquals(1, play?.startIndex)
    assertEquals(81.5, play!!.positionInTrack, 0.0)
  }

  // A snapshot from before the time was written: older than any live place.
  @Test fun aSnapshotPlaceWithNoTimeIsOlderThanAnyLivePlace() {
    val play = snapshot("book:A", savedAt = null).resumable(live("A", savedAt = 0L))?.play
    assertEquals(81.5, play!!.positionInTrack, 0.0)
  }

  // JS named no book: nothing resumes, however new the live place or old the snapshot.
  @Test fun noBookNamedStillWinsOverANewerLivePlace() {
    assertNull(snapshot(null, savedAt = 1_000L).resumable(live("A", savedAt = 9_000L)))
  }

  // A crash mid-play: the named book resumes where the engine was, not where JS last wrote.
  @Test fun theNamedBookResumesAtItsLivePlace() {
    val play = snapshot("book:A").resumable(live("A"))?.play
    assertEquals(1, play?.startIndex)
    assertEquals(81.5, play!!.positionInTrack, 0.0)
  }

  // A car-seen phone paused B in a cold runtime away from every server: JS wrote nothing, and
  // the snapshot still names A, saved before the engine's place on B. The engine's book and
  // place win.
  @Test fun theBookTheEngineWasOnResumesWhenTheSnapshotNamesAnOlderOne() {
    val item = snapshot("book:A", savedAt = 1_000L).resumable(live("B", savedAt = 2_000L))
    assertEquals("book:B", item?.id)
    assertEquals(1, item?.play?.startIndex)
    assertEquals(81.5, item!!.play!!.positionInTrack, 0.0)
  }

  // A dead process left the engine on B; JS later played A and named it with a newer place.
  // A resumes at JS's place, not the engine's older book.
  @Test fun aNewerNamedBookBeatsAnOlderLivePlaceOnAnotherBook() {
    val item = snapshot("book:A", savedAt = 2_000L).resumable(live("B", savedAt = 1_000L))
    assertEquals("book:A", item?.id)
    assertEquals(0, item?.play?.startIndex)
    assertEquals(30.0, item!!.play!!.positionInTrack, 0.0)
    // Saved at the same time is not later: the engine's book stays.
    assertEquals("book:B", snapshot("book:A", savedAt = 1_000L).resumable(live("B", savedAt = 1_000L))?.id)
  }

  // Either time missing (a snapshot from before the times, a live place never stamped): the
  // engine's book wins, as before.
  @Test fun aMissingTimeLeavesTheLiveBookWinning() {
    assertEquals("book:B", snapshot("book:A", savedAt = null).resumable(live("B", savedAt = 2_000L))?.id)
    assertEquals("book:B", snapshot("book:A", savedAt = 2_000L).resumable(live("B", savedAt = 0L))?.id)
  }

  // A stopped or finished book: JS names none and the live place was dropped with it.
  @Test fun noLivePlaceAndNoBookNamedIsNothingToResume() {
    assertNull(snapshot(null).resumable(null))
  }

  // JS named none on purpose (kids mode changed in a cold runtime, the book no longer the person
  // listening's): the engine's last book never overrides that.
  @Test fun aLivePlaceNeverResumesWhenJsNamedNoBook() {
    assertNull(snapshot(null).resumable(live("A")))
    // A snapshot kept from before `resume` existed names nothing either way: the live book wins.
    val old = snapshot(null, namesResume = false).resumable(live("B"))
    assertEquals("book:B", old?.id)
    assertEquals(81.5, old!!.play!!.positionInTrack, 0.0)
  }

  // A car tap's spec (playFromCar) takes the live place only on its own book.
  @Test fun anotherBooksLivePlaceLeavesTheSpecAsItIs() {
    val spec = item("A").play!!
    assertEquals(spec, spec.at(live("B")))
    assertEquals(spec, spec.at(null))
    assertEquals(81.5, spec.at(live("A")).positionInTrack, 0.0)
  }

  @Test fun aLiveBookNotListedOrNotDownloadedFallsBackToTheNamedOne() {
    val gone = snapshot("book:A").resumable(live("Gone"))
    assertEquals("book:A", gone?.id)
    assertEquals(30.0, gone!!.play!!.positionInTrack, 0.0)
    assertEquals("book:A", snapshot("book:A").resumable(live("Streamed"))?.id)
  }

  // The spec's file order can differ from the engine's: the file is found by its path.
  @Test fun theFileIsFoundByPathNotIndex() {
    val spec = item("A").play!!
    assertEquals(1, spec.at(LivePlace(ref("A"), "A/2.mp3", 0, 5.0)).startIndex)
    assertEquals(0, spec.at(LivePlace(ref("A"), "A/1.mp3", 1, 5.0)).startIndex)
    // A file the download no longer has: the spec's own start.
    assertEquals(spec, spec.at(LivePlace(ref("A"), "A/9.mp3", 1, 5.0)))
    // No path known: the index.
    assertEquals(1, spec.at(LivePlace(ref("A"), null, 1, 5.0)).startIndex)
    assertEquals(spec, spec.at(LivePlace(ref("A"), null, 7, 5.0)))
  }

  // ---- The recorder ----------------------------------------------------------------------

  private class Fake {
    var place: LivePlace? = null
    val saves = ArrayList<LivePlace>()
    var clears = 0
    val scheduled = ArrayList<Pair<Runnable, Long>>()

    var now = 100L

    val recorder = LivePlaceRecorder(
      place = { place },
      save = { saves.add(it) },
      clear = { clears++ },
      schedule = { r, ms -> scheduled.add(r to ms) },
      unschedule = { r -> scheduled.removeAll { it.first === r } },
      clock = { now },
    )

    /** The main looper runs what is due. */
    fun tick() {
      val due = scheduled.toList()
      scheduled.clear()
      due.forEach { it.first.run() }
    }
  }

  @Test fun aPlayingBookIsKeptEveryIntervalAndAtThePause() {
    val f = Fake()
    f.place = live("A", at = 10.0)
    f.recorder.onIsPlayingChanged(true)
    assertEquals(listOf(10.0), f.saves.map { it.position })
    assertEquals(listOf(LivePlaceRecorder.INTERVAL_MS), f.scheduled.map { it.second })
    f.place = live("A", at = 20.0)
    f.tick()
    f.place = live("A", at = 30.0)
    f.tick()
    assertEquals(listOf(10.0, 20.0, 30.0), f.saves.map { it.position })
    f.place = live("A", at = 33.0)
    f.recorder.onIsPlayingChanged(false)
    assertEquals(33.0, f.saves.last().position, 0.0)
    assertTrue("no tick once paused", f.scheduled.isEmpty())
  }

  // Each save is stamped; an unchanged place keeps the time it was first saved.
  @Test fun aSavedPlaceIsStampedWhenItIsSaved() {
    val f = Fake()
    f.place = live("A", at = 10.0, savedAt = 0L)
    f.recorder.onSeek()
    f.now = 200L
    f.recorder.onSeek()
    f.place = live("A", at = 20.0, savedAt = 0L)
    f.now = 300L
    f.recorder.onSeek()
    assertEquals(listOf(100L, 300L), f.saves.map { it.savedAt })
  }

  @Test fun aSeekIsKeptAtOnceAndAnUnchangedPlaceIsNotWrittenAgain() {
    val f = Fake()
    f.place = live("A", at = 50.0)
    f.recorder.onSeek()
    f.recorder.onSeek()
    assertEquals(1, f.saves.size)
  }

  // A stop, the end of the book and the app's own load drop it: a stopped or finished book
  // never resumes, and a book the app loads resumes where JS put it.
  @Test fun aDropClearsTheDiskAndStopsTheTicks() {
    val f = Fake()
    f.place = live("A")
    f.recorder.onIsPlayingChanged(true)
    f.recorder.drop()
    assertEquals(1, f.clears)
    assertTrue(f.scheduled.isEmpty())
    f.recorder.drop()
    assertEquals("once", 1, f.clears)
    // The same place kept again after a drop is written again.
    f.recorder.onSeek()
    assertEquals(2, f.saves.size)
  }

  // An ended book or an empty player has no place: nothing is written over the drop.
  @Test fun noPlaceWritesNothing() {
    val f = Fake()
    f.recorder.onIsPlayingChanged(false)
    f.recorder.onSeek()
    assertTrue(f.saves.isEmpty())
  }
}
