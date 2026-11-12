// Whether the phone has AudioSilo (decision 12): the phone app advertises the Data Layer
// capability `audiosilo_phone_app` (W4b). With no node advertising it, Setup offers "Get AudioSilo
// on your phone", which opens the Play Store on the phone (RemoteActivityHelper). The Data Layer
// listener itself is PhoneLink.
package app.audiosilo.wear.phone

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.wear.remote.interactions.RemoteActivityHelper
import app.audiosilo.wear.core.orNull
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.tasks.await

object PhoneApp {
  /** The capability the phone app advertises (its res/values wear.xml, W4b). */
  const val CAPABILITY = "audiosilo_phone_app"

  /** The phone app's package (the Wear app shares it: the Data Layer needs that). */
  const val PACKAGE = "app.audiosilo"

  /** True when a paired phone has the app, false when none does, null when the Data Layer can't say. */
  suspend fun installed(context: Context): Boolean? = orNull {
    Wearable.getCapabilityClient(context).getCapability(CAPABILITY, CapabilityClient.FILTER_ALL).await().nodes.isNotEmpty()
  }

  /** Open AudioSilo's Play Store page on the phone. True when the phone took it. */
  suspend fun openStoreOnPhone(context: Context): Boolean {
    val intent =
      Intent(Intent.ACTION_VIEW)
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .setData(Uri.parse("market://details?id=$PACKAGE"))
    return orNull {
      RemoteActivityHelper(context).startRemoteActivity(intent).await()
      true
    } ?: false
  }
}
