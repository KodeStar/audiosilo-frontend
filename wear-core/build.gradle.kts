// wear-core: the Wear OS app's Core (Track W4), the Kotlin port of targets/watch/Core. Pure
// Kotlin/JVM, no android.*, so its rules test on any JVM: `npm run test:wear` (JDK 17).
plugins {
  // The Kotlin Gradle plugin the Expo build resolves (2.2.10 at SDK 58; RN's catalog says 2.2.0):
  // the Wear app compiles with that version, so Core stays on it too. Bump them together
  // (`test:wear` checks the two agree once android/ has been generated).
  kotlin("jvm") version "2.2.10"
  kotlin("plugin.serialization") version "2.2.10"
}

group = "app.audiosilo"
version = "1.0"

kotlin {
  jvmToolchain(17)
}

dependencies {
  // `api`: the wire models are @Serializable, and :wear reads and writes them.
  api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
  api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}

tasks.test {
  testLogging {
    events("failed")
    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
  }
}
