// Continue listening's rule, a port of targets/watch/Core/ContinueOrder.swift (the phone's
// `isInProgress` (progress-view.ts) and Home's order (home-model.ts)): the books started and not
// finished, newest `updated_at` first.
package app.audiosilo.wear.core

object ContinueOrder {
  fun inProgress(all: List<ProgressRow>, limit: Int): List<ProgressRow> =
    all
      .filter { !it.finished && it.position > 0 }
      .sortedByDescending { ISOTime.parse(it.updatedAt)?.epochSeconds ?: 0.0 }
      .take(limit)
}
