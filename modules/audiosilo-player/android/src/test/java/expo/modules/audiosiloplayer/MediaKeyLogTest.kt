package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaKeyLogTest {
  private val id = "book:server-1.user-7:2:Terry%20Pratchett%2FMort"

  // The item id holds the connection id, the library id and the book's path: none is logged.
  @Test fun aCarItemIsNamedByAShortHashNeverByItsId() {
    val ref = MediaKeyLog.ref(id)
    assertTrue(ref, Regex("[0-9a-f]{8}").matches(ref))
    for (part in listOf("server-1", "user-7", "Terry", "Mort", "book:")) assertFalse(ref.contains(part))
  }

  @Test fun theSameItemReadsTheSameOnEveryLineAndAnotherReadsDifferently() {
    assertEquals(MediaKeyLog.ref(id), MediaKeyLog.ref(id))
    assertNotEquals(MediaKeyLog.ref(id), MediaKeyLog.ref("$id%202"))
  }

  @Test fun noItemReadsNone() {
    assertEquals("none", MediaKeyLog.ref(null))
  }
}
