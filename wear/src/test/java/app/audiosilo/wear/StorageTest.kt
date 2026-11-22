// The token store's rules (decision 11) with a plain AES key standing in for the Keystore one,
// the device id, and the file names.
package app.audiosilo.wear

import app.audiosilo.wear.core.Account
import app.audiosilo.wear.core.AckStore
import app.audiosilo.wear.core.BookRef
import app.audiosilo.wear.core.DownloadIndex
import app.audiosilo.wear.core.FileSpanStore
import app.audiosilo.wear.core.JsonFile
import app.audiosilo.wear.core.ListeningStart
import app.audiosilo.wear.core.LocalPlace
import app.audiosilo.wear.core.Outbox
import app.audiosilo.wear.core.PlaceStore
import app.audiosilo.wear.core.SpanEvent
import app.audiosilo.wear.core.SpanRecorder
import app.audiosilo.wear.storage.DeviceIdentity
import app.audiosilo.wear.storage.Files
import app.audiosilo.wear.storage.KeystoreCipher
import app.audiosilo.wear.storage.TokenCipher
import app.audiosilo.wear.storage.TokenStore
import java.io.File
import java.nio.file.Files as NioFiles
import java.time.Instant
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class PlainCipher(val key: SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()) : TokenCipher {
  override fun seal(plain: ByteArray) = KeystoreCipher.sealWith(key, plain)

  override fun open(sealed: ByteArray) = KeystoreCipher.openWith(key, sealed)
}

class TokenStoreTest {
  private val dir: File = NioFiles.createTempDirectory("tokens").toFile()

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  @Test
  fun keepsReadsAndDeletes() {
    val file = File(dir, "nb/session.bin")
    val store = TokenStore(file, PlainCipher())
    assertNull(store.token())
    assertTrue(store.setToken("as_tok_1"))
    assertEquals("as_tok_1", store.token())
    assertFalse("never the token in the clear", String(file.readBytes(), Charsets.ISO_8859_1).contains("as_tok_1"))
    assertTrue(store.setToken("as_tok_2"))
    assertEquals("as_tok_2", store.token())
    assertTrue(store.setToken(null))
    assertNull(store.token())
    assertFalse(file.exists())
    assertTrue("deleting nothing is fine", store.setToken(null))
  }

  @Test
  fun aNewTokenIsInstalledOnlyOnceTheOwnerCanBeKeptOnDisk() {
    val account = Account("server", "Home", 1, "reader", "https://home.invalid", signedInAt = Instant.EPOCH)
    val accountFile = JsonFile(File(dir, "account.json"), Account.serializer())
    val store = TokenStore(File(dir, "session.bin"), PlainCipher())
    val blocked = File(dir, ".account.json.tmp").apply { mkdir() }
    assertFalse(store.startSession(account, accountFile, "new token"))
    assertNull(store.token())
    blocked.delete()
    assertTrue(store.startSession(account, accountFile, "new token"))
    assertEquals(account, accountFile.read())
    assertEquals("new token", store.token())
  }

  @Test
  fun signingOutSurvivesARelaunchWhenTheAccountAndTokenCannotBeUnlinked() {
    fun undeletable(name: String) = object : File(dir, name) {
      override fun delete() = false
    }
    val metadata = undeletable("account.json").apply { writeText("previous account") }
    val session = undeletable("session.bin")
    val cipher = PlainCipher()
    val store = TokenStore(session, cipher)
    assertTrue(store.setToken("old token"))
    assertTrue(store.beginSignOut())
    assertFalse(metadata.delete())
    assertFalse(store.setToken(null))
    val relaunched = TokenStore(session, cipher)
    assertTrue("continue removing the old listening, even though the old metadata survived", relaunched.signOutPending)
    assertNull(relaunched.token())
    assertFalse("a missing token can still be repaired by its owner", TokenStore(File(dir, "missing"), cipher).signOutPending)
  }

  @Test
  fun eachSealIsFresh() {
    val c = PlainCipher()
    assertNotEquals(c.seal("same".toByteArray()).toList(), c.seal("same".toByteArray()).toList())
  }

  @Test
  fun aTokenUnderAnotherKeyReadsAsNone() {
    val file = File(dir, "session.bin")
    TokenStore(file, PlainCipher()).setToken("as_tok_1")
    // The Keystore key went (a reset, a restore onto another watch): signed out, not a crash.
    assertNull(TokenStore(file, PlainCipher()).token())
  }

  @Test
  fun aTamperedOrShortFileReadsAsNone() {
    val file = File(dir, "session.bin")
    val cipher = PlainCipher()
    TokenStore(file, cipher).setToken("as_tok_1")
    val bytes = file.readBytes()
    bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
    file.writeBytes(bytes)
    assertNull(TokenStore(file, cipher).token())
    file.writeBytes(ByteArray(5))
    assertNull(TokenStore(file, cipher).token())
  }

  @Test
  fun aFailedSealKeepsTheOldToken() {
    val file = File(dir, "session.bin")
    val good = PlainCipher(KeyGenerator.getInstance("AES").apply { init(256) }.generateKey())
    TokenStore(file, good).setToken("as_tok_1")
    val failing =
      object : TokenCipher {
        override fun seal(plain: ByteArray): ByteArray = throw IllegalStateException("keystore locked")

        override fun open(sealed: ByteArray) = good.open(sealed)
      }
    assertFalse(TokenStore(file, failing).setToken("as_tok_2"))
    assertEquals("as_tok_1", TokenStore(file, good).token())
  }
}

class DeviceIdentityTest {
  private val dir: File = NioFiles.createTempDirectory("device").toFile()

  @After
  fun tearDown() {
    dir.deleteRecursively()
  }

  @Test
  fun madeOnceAndKept() {
    val file = File(dir, "nb/device-id")
    val id = DeviceIdentity.deviceId(file)
    assertTrue(Regex("^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$").matches(id))
    assertEquals(id, DeviceIdentity.deviceId(file))
    assertEquals(id, file.readText())
  }
}

class FilesTest {
  @Test
  fun safeNamesAreReadableHashedAndDistinct() {
    // printf 'abc' | FNV-1a 64 = e71fa2190541574b
    assertEquals("abc-e71fa2190541574b", Files.safeName("abc"))
    val a = Files.safeName(BookRef(1, "Author/Book: One").key)
    val b = Files.safeName(BookRef(1, "Author/Book; One").key)
    assertNotEquals(a, b)
    assertTrue(Regex("^[A-Za-z0-9_]{0,60}-[0-9a-f]+$").matches(a))
    assertTrue(Files.safeName("x".repeat(100)).startsWith("x".repeat(60) + "-"))
  }

  @Test
  fun theTokenDeviceIdAndSentPlacesHaveNoBackupPaths() {
    val f = Files(File("/data/files"), File("/data/no_backup"))
    assertEquals(File("/data/no_backup/session.bin"), f.session)
    assertEquals(File("/data/no_backup/device-id"), f.deviceIdFile)
    assertEquals(File("/data/no_backup/sent-places.json"), f.sentPlaces)
    assertEquals(File("/data/files/downloads.json"), f.downloadsIndex)
    assertTrue(f.item(BookRef(1, "A/B")).path.startsWith("/data/files/items/"))
  }

  @Test
  fun freeSpaceIsUnknownOnlyWhereTheVolumeCannotBeRead() {
    val dir = NioFiles.createTempDirectory("space").toFile()
    try {
      // A real volume answers a number (0 on a full one, which is known, not unknown).
      assertNotNull(Files(dir, dir).freeBytes())
      assertNull(Files(File(dir, "missing/files"), dir).freeBytes())
    } finally {
      dir.deleteRecursively()
    }
  }
}

class DownloadedPlaceTest {
  @Test
  fun removingThenDownloadingAgainRecoversOnlyTheNewListening() {
    val root = NioFiles.createTempDirectory("wear-download").toFile()
    try {
      val files = Files(File(root, "files"), File(root, "no_backup"))
      val ref = BookRef(1, "Author/Book")
      val now = Instant.parse("2026-11-22T12:00:00Z")
      val acks = AckStore(files.acks)
      fun launch(): Pair<Outbox, PlaceStore> {
        val outbox = Outbox(files.root, acks, "watch", sentPlacesFile = files.sentPlaces)
        val places = PlaceStore(files.places)
        val spans = SpanRecorder(FileSpanStore(files.openSpan, files.openSpanMove), acks, emit = outbox::append)
        outbox.recoverListening("account", places, spans)
        return outbox to places
      }
      val index = DownloadIndex(files.downloadsIndex)
      index.enqueue(ref, "Book", null, now)
      val (outbox, places) = launch()
      val cut = SpanEvent("last", libraryId = ref.libraryId, path = ref.path, fromPos = 10.0, toPos = 25.0,
        startedAt = now.minusSeconds(15).toString(), endedAt = now.toString(), start = ListeningStart.RESUME)
      forgetDownloadedPlace(ref, places, outbox) {
        outbox.append(listOf(cut))
        places.set(ref, LocalPlace(cut.toPos, at = now))
      }
      index.remove(ref)

      val (again, restored) = launch()
      assertNull(restored.place(ref))
      assertEquals(listOf(cut), again.events)
      assertTrue(index.enqueue(ref, "Book", null, now.plusSeconds(1)))
      assertNull(restored.place(ref))
      val replay = cut.copy(id = "replay", fromPos = 0.0, toPos = 8.0, endedAt = now.plusSeconds(9).toString())
      again.append(listOf(replay))
      assertEquals(8.0, launch().second.place(ref)!!.position, 0.0)
    } finally {
      root.deleteRecursively()
    }
  }
}
