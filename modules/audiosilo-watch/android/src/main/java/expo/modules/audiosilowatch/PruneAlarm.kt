// The pair prune's one alarm and the boot receiver that sets it again after a boot, kept in step
// (fe#285): the receiver is on exactly while an alarm is set. Each change sets the alarm, notes its
// time and turns the receiver under one lock, so a retry set from the alarm's receiver (outside
// WearLink's `lock`) and a send arming its pair never leave the receiver off with an alarm set.
// Nothing turns the receiver off but `arm(null)`, which WearLink calls only under its `lock`, from
// what the Data Layer holds then. Pure (the alarm and the receiver are `Device`'s), so it is tested.
package expo.modules.audiosilowatch

class PruneAlarm(private val device: Device) {
  /** The phone's side: AlarmManager and the receiver's enabled setting (WearLink). */
  interface Device {
    /**
     * Set the one alarm for `at` (epoch ms; its `attempt`th retry when above 0), or cancel it
     * (null). False when it could not.
     */
    fun alarm(at: Long?, attempt: Int): Boolean

    /** PairPruneBootReceiver on or off. */
    fun bootReceiver(on: Boolean)
  }

  /**
   * The time the alarm is set for (null for none), so an answer that changes nothing sets none.
   * `UNKNOWN` in a new process (an alarm an earlier one set outlives it) and once the alarm went
   * off: the next answer is applied whatever it is.
   */
  private var armedAt: Long? = UNKNOWN

  /** The alarm at `at`, the first pair's `expires_at` (null: no pair held, so none). */
  @Synchronized
  fun arm(at: Long?) {
    if (at != armedAt) set(at, 0)
  }

  /** The `attempt`th retry of a sweep that did not get through, at `at`: it takes the alarm's place. */
  @Synchronized
  fun retry(at: Long, attempt: Int) = set(at, attempt)

  /**
   * The alarm went off, or a boot dropped it: whatever its sweep finds is set again (an alarm a
   * moment early must not leave its pair to the next start), and one that finds no pair turns the
   * receiver off there, under WearLink's `lock`.
   */
  @Synchronized
  fun due() {
    armedAt = UNKNOWN
  }

  private fun set(at: Long?, attempt: Int) {
    if (!device.alarm(at, attempt)) return
    armedAt = at
    device.bootReceiver(on = at != null)
  }

  private companion object {
    const val UNKNOWN = Long.MIN_VALUE
  }
}
