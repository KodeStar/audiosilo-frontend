package expo.modules.audiosiloplayer

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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

  private fun row(artwork: String?) =
    CarItem("book:a", "A", "", null, finished = false, downloaded = true, artwork = artwork, play = null)

  // The device run: a row whose snapshot named a cover file that was gone since (a download
  // removed) showed the warning triangle, the provider unable to open its URI.
  @Test fun aRowWhoseCoverFileIsGoneShowsTheBundledOne() {
    val dir = kotlin.io.path.createTempDirectory("car-art").toFile()
    try {
      val cover = File(dir, "cover.jpg").apply { writeBytes(byteArrayOf(1, 2, 3)) }
      val there = row("file://${cover.absolutePath}")
      assertEquals(there.artworkKey, ArtworkProvider.browseArtworkKey(there))
      assertNull(ArtworkProvider.browseArtworkKey(row("file://${File(dir, "gone.jpg").absolutePath}")))
      assertNull(ArtworkProvider.browseArtworkKey(row(null)))
    } finally {
      dir.deleteRecursively()
    }
  }
}
