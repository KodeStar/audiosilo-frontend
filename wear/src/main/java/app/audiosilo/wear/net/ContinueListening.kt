// Continue listening on the watch (decision 3: no library browsing in v1; the twin of
// targets/watch/Net/ContinueListening.swift): `GET /me/progress`, the books started and not
// finished, newest first, at most 10. The rows carry no titles, so each book's `/item` is read
// once and kept (items/, also what offline playback needs). The rows also keep each book's server
// place for a downloaded book to open at when the pull before play gets no answer (`keptPlace`).
package app.audiosilo.wear.net

import app.audiosilo.wear.core.APIError
import app.audiosilo.wear.core.BookRef
import app.audiosilo.wear.core.ContinueRow
import app.audiosilo.wear.core.ContinueRows
import app.audiosilo.wear.core.ItemCache
import app.audiosilo.wear.core.JsonFile
import app.audiosilo.wear.core.ProgressRow
import app.audiosilo.wear.core.RenditionPlan
import app.audiosilo.wear.core.orNull
import app.audiosilo.wear.storage.Files
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.builtins.ListSerializer

class ContinueListening(private val files: Files) {
  private val file = JsonFile(files.continueRows, ListSerializer(ContinueRow.serializer()))

  private val _rows = MutableStateFlow(file.read() ?: emptyList())
  val rows: StateFlow<List<ContinueRow>> = _rows.asStateFlow()

  private val _loading = MutableStateFlow(false)
  val loading: StateFlow<Boolean> = _loading.asStateFlow()

  /** Why the last refresh failed ("" when it did not). */
  private val _problem = MutableStateFlow("")
  val problem: StateFlow<String> = _problem.asStateFlow()

  /**
   * Bumped by each refresh and by `clear`: an answer an older one was waiting for (an account
   * since signed out or replaced, or just an older read) is dropped.
   */
  private val generation = AtomicInteger()

  suspend fun refresh(api: ApiClient) {
    val mine = generation.incrementAndGet()
    fun current() = mine == generation.get()
    _loading.value = true
    try {
      val all = api.allProgress()
      val next =
        ContinueRows.build(
          all,
          cached = { files.loadItem(it)?.book },
          fetch = { ref -> orNull { api.item(ref).also { if (current()) files.saveItem(ref, ItemCache(it)) } } },
          stillWanted = ::current,
        ) ?: return
      if (!current()) return
      _rows.value = next
      _problem.value = ""
      file.write(next)
    } catch (e: CancellationException) {
      throw e
    } catch (e: APIError) {
      if (current()) _problem.value = if (e.status == 401) RenditionPlan.message(RenditionPlan.Refusal.SignedOut) ?: "" else CANT_REACH
    } catch (_: Exception) {
      if (current()) _problem.value = CANT_REACH
    } finally {
      if (current()) _loading.value = false
    }
  }

  /**
   * The server's place for `ref` as the last refresh read it, for a downloaded book whose pull
   * before play got no answer (the player): offline it opens there, never at 0 under the
   * server's place. A newer place of the watch's own still wins (Resume.plan).
   */
  fun keptPlace(ref: BookRef): ProgressRow? = _rows.value.firstOrNull { it.ref == ref }?.keptPlace()

  fun clear() {
    generation.incrementAndGet()
    _loading.value = false
    _rows.value = emptyList()
    _problem.value = ""
    file.write(null)
  }

  companion object {
    const val CANT_REACH = "Can't reach your server."
  }
}
