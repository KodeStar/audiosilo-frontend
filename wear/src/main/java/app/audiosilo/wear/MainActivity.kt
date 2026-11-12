package app.audiosilo.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import app.audiosilo.wear.ui.WearApp

class MainActivity : ComponentActivity() {
  private val model by lazy { AppModel.get(this) }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent { WearApp(model) }
  }

  override fun onStart() {
    super.onStart()
    model.becameActive()
  }

  override fun onStop() {
    model.wentToBackground()
    super.onStop()
  }
}
