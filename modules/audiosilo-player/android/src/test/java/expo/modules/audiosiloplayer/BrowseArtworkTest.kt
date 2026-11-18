package expo.modules.audiosiloplayer

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The device run: a book with no cover showed a warning triangle in the car's lists (Continue,
// Library, Downloads). Its row shows the bundled cover instead.
class BrowseArtworkTest {
  private val authority = "app.audiosilo.dev.audiosilo.artwork"

  @Test fun aBookWithNoCoverShowsTheBundledOne() {
    assertEquals(
      "android.resource://app.audiosilo.dev/drawable/${ArtworkProvider.PLACEHOLDER}",
      ArtworkProvider.browseArtwork(authority, "app.audiosilo.dev", null),
    )
    // The resource the URI names is the one the module ships.
    assertTrue(File("src/main/res/drawable-nodpi/${ArtworkProvider.PLACEHOLDER}.png").isFile)
  }

  @Test fun aBookWithACoverShowsItsOwn() {
    val key = "0123456789abcdef0123456789abcdef"
    assertEquals("content://$authority/art/$key", ArtworkProvider.browseArtwork(authority, "app.audiosilo.dev", key))
  }
}
