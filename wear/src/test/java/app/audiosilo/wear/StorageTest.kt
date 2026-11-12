// The token store's rules (decision 11) with a plain AES key standing in for the Keystore one,
// the device id, and the file names.
package app.audiosilo.wear

import app.audiosilo.wear.core.BookRef
import app.audiosilo.wear.storage.DeviceIdentity
import app.audiosilo.wear.storage.Files
import app.audiosilo.wear.storage.KeystoreCipher
import app.audiosilo.wear.storage.TokenCipher
import app.audiosilo.wear.storage.TokenStore
import java.io.File
import java.nio.file.Files as NioFiles
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
  fun everythingButTheTokenAndIdLivesUnderFiles() {
    val f = Files(File("/data/files"), File("/data/no_backup"))
    assertEquals(File("/data/no_backup/session.bin"), f.session)
    assertEquals(File("/data/no_backup/device-id"), f.deviceIdFile)
    assertEquals(File("/data/files/downloads.json"), f.downloadsIndex)
    assertTrue(f.item(BookRef(1, "A/B")).path.startsWith("/data/files/items/"))
  }
}
