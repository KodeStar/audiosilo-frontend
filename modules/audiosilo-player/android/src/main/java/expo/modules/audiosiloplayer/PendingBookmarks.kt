package expo.modules.audiosiloplayer

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Bookmarks pressed (notification / Android Auto) while no JS listened, kept in the player's
 * SharedPreferences until JS drains them (`consumePendingBookmarks`, oldest first). Capped so a
 * device that never opens the app again can't grow it without bound.
 */
object PendingBookmarks {
  private const val KEY = "pending_bookmarks"
  private const val MAX = 200

  @Synchronized
  fun append(context: Context, book: BookRef, fileIndex: Int, relPath: String?, position: Double) {
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
        // The file by its path (fe#185): JS reads the press in the order the book's files are
        // in then. Absent when the item's id has another shape.
        .apply { if (relPath != null) put("relPath", relPath) }
        .put("position", position),
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
      val entry = mapOf(
        "connectionId" to o.optString("connectionId"),
        "libraryId" to o.optLong("libraryId").toDouble(),
        "path" to o.optString("path"),
        "trackIndex" to o.optInt("trackIndex"),
        "position" to o.optDouble("position", 0.0),
      )
      // One kept by an older binary has no path: JS reads it by its index, as before.
      val relPath = o.optString("relPath", "")
      out.add(if (relPath.isEmpty()) entry else entry + ("relPath" to relPath))
    }
    return out
  }

  private fun prefs(context: Context) =
    context.getSharedPreferences(AudiosiloPlayerService.PREFS, Context.MODE_PRIVATE)
}
