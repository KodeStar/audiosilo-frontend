// The transport glyphs, drawn here (no icon library on the watch: the phone vendors its icons as
// SVG too). 24 x 24 viewports, filled.
package app.audiosilo.wear.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

object Glyphs {
  private fun glyph(name: String, draw: PathBuilder.() -> Unit): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).path(fill = SolidColor(Color.White), pathBuilder = draw).build()

  val play: ImageVector =
    glyph("play") {
      moveTo(8f, 5f)
      lineTo(19f, 12f)
      lineTo(8f, 19f)
      close()
    }

  val pause: ImageVector =
    glyph("pause") {
      moveTo(6f, 5f)
      lineTo(10f, 5f)
      lineTo(10f, 19f)
      lineTo(6f, 19f)
      close()
      moveTo(14f, 5f)
      lineTo(18f, 5f)
      lineTo(18f, 19f)
      lineTo(14f, 19f)
      close()
    }

  val previous: ImageVector =
    glyph("previous") {
      moveTo(6f, 6f)
      lineTo(8f, 6f)
      lineTo(8f, 18f)
      lineTo(6f, 18f)
      close()
      moveTo(18f, 6f)
      lineTo(18f, 18f)
      lineTo(9.5f, 12f)
      close()
    }

  val next: ImageVector =
    glyph("next") {
      moveTo(16f, 6f)
      lineTo(18f, 6f)
      lineTo(18f, 18f)
      lineTo(16f, 18f)
      close()
      moveTo(6f, 6f)
      lineTo(14.5f, 12f)
      lineTo(6f, 18f)
      close()
    }
}
