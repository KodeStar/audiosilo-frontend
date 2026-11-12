// Ported from watch-core/Tests/WatchCoreTests/QueryStringTests.swift: every character but RFC
// 3986's unreserved ones percent-encoded, so Go's query parser reads a book path back exactly (a raw
// `;` drops the pair, a raw `+` is a space). Plus Wear's sync triggers (SyncSchedule).
package app.audiosilo.wear.core

import java.net.URI
import java.net.URLDecoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QueryStringTest {
  @Test
  fun encodesEverythingButTheUnreservedCharacters() {
    assertEquals("path=Smith%3B%20Jones%2FBook%201.m4b", QueryString.encode(mapOf("path" to "Smith; Jones/Book 1.m4b")))
    assertEquals("path=C%2B%2B%20%26%20Tom%3DJerry", QueryString.encode(mapOf("path" to "C++ & Tom=Jerry")))
    assertEquals("path=100%25%20%231%3F%20a%2Cb", QueryString.encode(mapOf("path" to "100% #1? a,b")))
    assertEquals("path=A-Z_a.z~09", QueryString.encode(mapOf("path" to "A-Z_a.z~09")))
  }

  @Test
  fun encodesNonASCIIAsUTF8() {
    assertEquals(
      "path=Bront%C3%AB%2FJane%20Eyre%20%F0%9F%93%9A.mp3",
      QueryString.encode(mapOf("path" to "Brontë/Jane Eyre 📚.mp3")),
    )
  }

  @Test
  fun sortsByNameAndEncodesNames() {
    assertEquals(
      "download=1&kind=watch&path=a",
      QueryString.encode(mapOf("path" to "a", "kind" to "watch", "download" to "1")),
    )
    assertEquals("a%20b=c", QueryString.encode(mapOf("a b" to "c")))
    assertEquals("", QueryString.encode(emptyMap()))
  }

  @Test
  fun readsBackAsTheValuesSent() {
    val query =
      mapOf("path" to "Smith; Jones/Book +1 & 2=3 %41 #?/Brontë 📚.mp3", "rendition" to "watch", "download" to "1")
    val url = "http://192.168.1.10:8080/api/v1/libraries/3/stream?" + QueryString.encode(query)
    val raw = URI(url).rawQuery
    val read =
      raw.split("&").associate {
        val (k, v) = it.split("=", limit = 2)
        URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
      }
    assertEquals(query, read)
    assertFalse(url.contains(";"))
  }
}

class SyncScheduleTest {
  private val triggers = SyncSchedule.Trigger.entries

  @Test
  fun nothingWaitingSchedulesNothing() {
    for (t in triggers) {
      for (front in listOf(true, false)) {
        assertEquals(SyncSchedule.Plan(false, false, false), SyncSchedule.plan(t, 0, front))
      }
    }
    assertFalse(SyncSchedule.foregroundTimer(0, true))
  }

  @Test
  fun inFrontTheAppSendsItself() {
    for (t in triggers - SyncSchedule.Trigger.BACKGROUND) {
      assertEquals("$t", SyncSchedule.Plan(flushNow = true, expedite = false, backstop = true), SyncSchedule.plan(t, 3, true))
    }
    assertTrue(SyncSchedule.foregroundTimer(3, true))
  }

  // Decision 9: expedited when a span closes with events unsent or the app backgrounds.
  @Test
  fun inTheBackgroundTheWorkerSendsExpedited() {
    assertEquals(
      SyncSchedule.Plan(flushNow = false, expedite = true, backstop = true),
      SyncSchedule.plan(SyncSchedule.Trigger.BACKGROUND, 3, true),
    )
    for (t in triggers) {
      assertEquals("$t", SyncSchedule.Plan(flushNow = false, expedite = true, backstop = true), SyncSchedule.plan(t, 1, false))
    }
    assertFalse("no 60 s timer in the background", SyncSchedule.foregroundTimer(3, false))
  }
}
