package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// fe#349: a streamed cover's URL carries the media token, and the artwork URI an item names is
// logged by the system UI. The URI names it by a key that gives nothing away.
class RemoteArtworkTest {
  private fun cover(book: String, token: String = "secret-token") =
    "https://books.example/api/v1/libraries/1/cover?path=$book&token=$token"

  @Test fun theKeyHidesTheTokenAndThePath() {
    val url = cover("Author/Book")
    val key = RemoteArtwork.register(url)
    assertFalse(key.contains("secret"))
    assertFalse(key.contains("Book"))
    assertTrue(Regex("[0-9a-f]{32}").matches(key))
    assertEquals(url, RemoteArtwork.urlFor(key))
  }

  @Test fun oneUrlKeepsOneKey() {
    val url = cover("Author/Same")
    assertEquals(RemoteArtwork.register(url), RemoteArtwork.register(url))
    // Another token is another URL, so another key: a stale one never fetches with a new token.
    assertNotEquals(RemoteArtwork.register(url), RemoteArtwork.register(cover("Author/Same", "other")))
  }

  @Test fun anUnknownKeyNamesNothing() {
    assertNull(RemoteArtwork.urlFor("0123456789abcdef0123456789abcdef"))
    assertNull(RemoteArtwork.urlFor(""))
  }

  @Test fun onlyTheLastFewCoversAreKept() {
    val first = RemoteArtwork.register(cover("Evicted/First"))
    repeat(RemoteArtwork.MAX) { RemoteArtwork.register(cover("Later/$it")) }
    assertNull(RemoteArtwork.urlFor(first))
  }

  @Test fun onlyServerUrlsAreRemote() {
    assertTrue(RemoteArtwork.isRemote("https://host/cover?token=x"))
    assertTrue(RemoteArtwork.isRemote("HTTP://host/cover"))
    assertFalse(RemoteArtwork.isRemote("file:///data/user/0/app/files/cover.jpg"))
    assertFalse(RemoteArtwork.isRemote("content://app.audiosilo.artwork/art/abc"))
    assertFalse(RemoteArtwork.isRemote("/data/user/0/app/files/cover.jpg"))
  }
}
