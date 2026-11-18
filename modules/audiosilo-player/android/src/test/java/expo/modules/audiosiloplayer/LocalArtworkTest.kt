package expo.modules.audiosiloplayer

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The device run: Android Auto tried to load a downloaded book's cover from its file:// URI,
// which another app cannot read. A loaded item names a cover file by the artwork provider's
// URI instead, which the provider serves.
class LocalArtworkTest {
  private val authority = "app.audiosilo.dev.audiosilo.artwork"
  private val cover = "/data/user/0/app.audiosilo.dev/files/downloads/abc/cover.jpg"

  @Test fun aDownloadedCoverGoesOutAsTheProvidersUri() {
    val uri = ArtworkProvider.itemArtwork("file://$cover", authority)
    val key = CarSnapshot.artworkKey(File(cover))
    assertEquals("content://$authority/art/$key", uri)
    // The provider finds the file by the key, as it finds a snapshot's.
    assertEquals(File(cover), LocalArtwork.fileFor(key))
    // Nothing of the path in the URI.
    assertTrue(!uri.contains("downloads") && !uri.contains("cover.jpg"))
  }

  @Test fun aBarePathIsAFileToo() {
    assertEquals(
      ArtworkProvider.itemArtwork("file://$cover", authority),
      ArtworkProvider.itemArtwork(cover, authority),
    )
  }

  @Test fun anEscapedFileUriNamesTheFileItSpells() {
    assertEquals(File("/data/a b/cover.jpg"), CarSnapshot.artworkFile("file:///data/a%20b/cover.jpg"))
    // Unescaped, it is still the file it spells.
    assertEquals(File("/data/a b/cover.jpg"), CarSnapshot.artworkFile("file:///data/a b/cover.jpg"))
  }

  @Test fun aStreamedCoverStaysTheAppsOwnUri() {
    val url = "https://books.example/api/v1/libraries/1/cover?path=A&token=secret"
    assertTrue(ArtworkProvider.itemArtwork(url, authority).startsWith("audiosilo-artwork://remote/"))
  }

  @Test fun anythingElseGoesOutAsItIs() {
    val content = "content://$authority/art/0123456789abcdef0123456789abcdef"
    assertEquals(content, ArtworkProvider.itemArtwork(content, authority))
    assertNull(CarSnapshot.artworkFile(content))
    assertNull(CarSnapshot.artworkFile("file:"))
  }

  @Test fun onlyTheNewestCoversAreServed() {
    val first = LocalArtwork.register(File("/data/evicted/cover.jpg"))
    repeat(LocalArtwork.MAX) { LocalArtwork.register(File("/data/later/$it/cover.jpg")) }
    assertNull(LocalArtwork.fileFor(first))
    assertNull(LocalArtwork.fileFor("0123456789abcdef0123456789abcdef"))
  }
}
