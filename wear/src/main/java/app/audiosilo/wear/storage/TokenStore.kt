// The session token (decision 11): sealed with a non-exportable Android Keystore AES-GCM key and
// kept in noBackupFilesDir, so it never leaves this watch (the Apple Watch's keychain item with
// `ThisDeviceOnly`). Nothing else secret is kept.
package app.audiosilo.wear.storage

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import app.audiosilo.wear.core.JsonFile
import java.io.File
import java.io.IOException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Seals and opens the token's bytes (the Keystore key on the watch; a plain key in the tests). */
interface TokenCipher {
  fun seal(plain: ByteArray): ByteArray

  /** Throws when the bytes do not open (another key, or tampered). */
  fun open(sealed: ByteArray): ByteArray
}

/** AES-256-GCM under an Android Keystore key that never leaves the secure hardware. */
class KeystoreCipher(private val alias: String = ALIAS) : TokenCipher {
  private fun key(): SecretKey {
    val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (ks.getKey(alias, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    gen.init(
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return gen.generateKey()
  }

  override fun seal(plain: ByteArray): ByteArray = sealWith(key(), plain)

  override fun open(sealed: ByteArray): ByteArray = openWith(key(), sealed)

  companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val ALIAS = "audiosilo.session"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    /** The IV (the cipher's own, 12 bytes) followed by the ciphertext and its tag. */
    fun sealWith(key: SecretKey, plain: ByteArray): ByteArray {
      val c = Cipher.getInstance(TRANSFORM)
      c.init(Cipher.ENCRYPT_MODE, key)
      val iv = c.iv
      check(iv.size == IV_BYTES) { "unexpected IV size ${iv.size}" }
      return iv + c.doFinal(plain)
    }

    fun openWith(key: SecretKey, sealed: ByteArray): ByteArray {
      if (sealed.size <= IV_BYTES) throw IOException("sealed token too short")
      val c = Cipher.getInstance(TRANSFORM)
      c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
      return c.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }
  }
}

/** Thread-safe. */
class TokenStore(private val file: File, private val cipher: TokenCipher) {
  /**
   * The token once opened, for this process: every request asks for it, and opening it is a trip
   * to the Keystore each time. Only this store writes the file, so it is never stale.
   */
  private var opened: String? = null

  /** The token, or null when there is none or it no longer opens (the key went with a reset). */
  @Synchronized
  fun token(): String? {
    opened?.let { return it }
    if (!file.exists()) return null
    return try {
      String(cipher.open(file.readBytes()), Charsets.UTF_8).also { opened = it }
    } catch (_: Exception) {
      null
    }
  }

  /**
   * Keep the token (null deletes it). Returns whether it was kept. Written beside and moved in, so
   * a token that could not be replaced stays and a failed sign-in again loses nothing.
   */
  @Synchronized
  fun setToken(token: String?): Boolean {
    if (token == null) {
      opened = null
      return !file.exists() || file.delete()
    }
    return try {
      JsonFile.atomicWrite(file, cipher.seal(token.toByteArray(Charsets.UTF_8)))
      opened = token
      true
    } catch (_: Exception) {
      false
    }
  }
}
