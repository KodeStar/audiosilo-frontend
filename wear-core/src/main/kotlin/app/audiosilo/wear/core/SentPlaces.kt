// The resume record for one book, ported from targets/watch/Core/Outbox.swift.
package app.audiosilo.wear.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
internal sealed interface SentPlace {
  @Serializable @SerialName("heard") data class Heard(val place: LocalPlace) : SentPlace
  @Serializable @SerialName("finished") data class Finished(val through: StoredInstant) : SentPlace
  @Serializable @SerialName("removed") data object Removed : SentPlace

  /** Independent copies use the watch clock. A finish wins a tie. Only fresh listening clears a removal. */
  fun newer(other: SentPlace): SentPlace = when {
    this is Removed || other is Removed -> Removed
    this is Finished && other is Finished -> Finished(maxOf(through, other.through))
    this is Finished && other is Heard -> if (other.place.at > through) other else this
    this is Heard && other is Finished -> if (place.at > other.through) this else other
    this is Heard && other is Heard && other.place.at > place.at -> other
    else -> this
  }

  companion object {
    /** Within one outbox, the last heard cut or finish in queue order wins, even across a clock change. */
    fun lastIn(events: List<ListeningEvent>): Map<String, SentPlace> = buildMap {
      for (event in events) {
        val at = event.time ?: continue
        when (event) {
          is SpanEvent -> if (event.heardPlace) {
            put(event.ref.key, Heard(LocalPlace(event.toPos, event.toFile, event.toFilePos, at, event.playbackSpeed ?: 1.0)))
          }
          is FinishEvent -> if (event.kind == "finish") put(event.ref.key, Finished(at))
        }
      }
    }
  }
}

@Serializable
internal data class SentPlaces(
  val account: String,
  val books: Map<String, SentPlace> = emptyMap(),
  // Earlier Wear versions stored a list of heard cuts in the fallback directory.
  val cuts: List<SpanEvent> = emptyList(),
) {
  fun upgraded() = if (cuts.isEmpty()) this else SentPlaces(account, SentPlace.lastIn(cuts) + books)
}
