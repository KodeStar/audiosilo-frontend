package expo.modules.audiosiloplayer

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Bookmarks pressed (notification / Android Auto) while no JS listened, kept in the player's
 * SharedPreferences until JS drains them (`consumePendingBookmarks`, oldest first). Capped so a
 * device that never opens the app again can't grow it without bound.
 */
object PendingBookmarks {
  private const val KEY = "pending_bookmarks"
  private const val MAX = 200

  @Synchronized
  fun append(context: Context, book: BookRef, fileIndex: Int, position: Double) {
    val prefs = prefs(context)
    val arr = try {
      JSONArray(prefs.getString(KEY, "[]"))
    } catch (_: Exception) {
      JSONArray()
    }
    arr.put(
      JSONObject()
        .put("connectionId", book.connectionId)
        .put("libraryId", book.libraryId)
        .put("path", book.path)
        .put("trackIndex", fileIndex)
        .put("position", position)
        .put("at", isoNow()),
    )
    while (arr.length() > MAX) arr.remove(0)
    // commit, not apply: the process may die right after a press with nothing else running.
    prefs.edit().putString(KEY, arr.toString()).commit()
  }

  /** Every pending bookmark, oldest first, and clears the list. */
  @Synchronized
  fun consume(context: Context): List<Map<String, Any>> {
    val prefs = prefs(context)
    val raw = prefs.getString(KEY, null) ?: return emptyList()
    prefs.edit().remove(KEY).commit()
    val arr = try {
      JSONArray(raw)
    } catch (_: Exception) {
      return emptyList()
    }
    val out = ArrayList<Map<String, Any>>()
    for (i in 0 until arr.length()) {
      val o = arr.optJSONObject(i) ?: continue
      out.add(
        mapOf(
          "connectionId" to o.optString("connectionId"),
          "libraryId" to o.optLong("libraryId").toDouble(),
          "path" to o.optString("path"),
          "trackIndex" to o.optInt("trackIndex"),
          "position" to o.optDouble("position", 0.0),
          "at" to o.optString("at"),
        ),
      )
    }
    return out
  }

  private fun prefs(context: Context) =
    context.getSharedPreferences(AudiosiloPlayerService.PREFS, Context.MODE_PRIVATE)

  /** Fixed-width UTC with milliseconds, like the app's bookmark timestamps. */
  private fun isoNow(): String {
    val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    f.timeZone = TimeZone.getTimeZone("UTC")
    return f.format(Date())
  }
}
