// wear-core: the Wear OS app's Core (Track W4), pure Kotlin/JVM with no android.* so its rules
// test on any JVM (`./gradlew test`, JDK 17). The Wear module `:wear` includes this build as a
// composite (`includeBuild('../wear-core')`, wired by plugins/withWearApp.js) and depends on
// `app.audiosilo:wear-core`, which Gradle substitutes with this project.
pluginManagement {
  repositories {
    gradlePluginPortal()
    mavenCentral()
  }
}

dependencyResolutionManagement {
  repositories {
    mavenCentral()
  }
}

rootProject.name = "wear-core"
