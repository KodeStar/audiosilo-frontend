// Ask for a high-bandwidth network before a book's download (decision 8, Wear's own guidance for
// large transfers): Wi-Fi, unmetered, with internet. The Bluetooth proxy through the phone is slow,
// so a book waits for Wi-Fi unless the listener picks the phone's connection (Q3). The request
// stays registered while the download runs (releasing it lets the system drop the Wi-Fi), so
// `close` it when done.
package app.audiosilo.wear.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import java.io.Closeable
import java.net.InetAddress
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Dns
import okhttp3.OkHttpClient

class WifiRequest(context: Context) : Closeable {
  private val cm = context.getSystemService(ConnectivityManager::class.java)
  private val network = MutableStateFlow<Network?>(null)
  private val callback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(n: Network) {
        network.value = n
      }

      override fun onLost(n: Network) {
        if (network.value == n) network.value = null
      }
    }
  private var registered = false

  /** Ask (once) and wait up to `timeoutMs` for the network; null when none came. */
  suspend fun await(timeoutMs: Long): Network? {
    if (!registered) {
      val request =
        NetworkRequest.Builder()
          .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
          .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
          .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
          .build()
      cm.requestNetwork(request, callback)
      registered = true
    }
    return withTimeoutOrNull(timeoutMs) { network.filterNotNull().first() }
  }

  override fun close() {
    if (registered) {
      try {
        cm.unregisterNetworkCallback(callback)
      } catch (_: IllegalArgumentException) {}
      registered = false
    }
  }

  companion object {
    /** How long a book waits for Wi-Fi before its row offers the phone's connection (Q3). */
    const val OFFER_SLOW_AFTER_MS = 30_000L

    /** How long one run waits for Wi-Fi in all before handing over to the worker's backoff. */
    const val WAIT_LIMIT_MS = 10 * 60_000L

    /** A copy of `base` whose sockets and DNS go over `network` only. */
    fun bind(base: OkHttpClient, network: Network): OkHttpClient =
      base
        .newBuilder()
        .socketFactory(network.socketFactory)
        .dns(
          object : Dns {
            override fun lookup(hostname: String): List<InetAddress> = network.getAllByName(hostname).toList()
          }
        )
        .build()
  }
}
