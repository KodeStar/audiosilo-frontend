package expo.modules.audiosiloplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AuthScopeTest {
  private val book = mapOf("Authorization" to "Bearer t", "CF-Access-Client-Secret" to "proxy-secret")

  @Test fun anOriginIsLowerCasedWithTheSchemesDefaultPort() {
    assertEquals("https://books.example.com:443", AuthScope.origin("HTTPS", "Books.Example.com", -1))
    assertEquals("http://192.168.1.20:8080", AuthScope.origin("http", "192.168.1.20", 8080))
    assertEquals("http://nas:80", AuthScope.origin("http", "nas", -1))
  }

  @Test fun noSchemeOrHostIsNoOrigin() {
    assertNull(AuthScope.origin(null, "books.example.com", -1))
    assertNull(AuthScope.origin("https", null, -1))
    assertNull(AuthScope.origin("https", "", -1))
  }

  // Allowed: an https origin gets the token and the proxy headers.
  @Test fun anHttpsOriginGetsEveryHeader() {
    assertEquals(book, AuthScope.headersFor("https://books.example.com:443", book))
  }

  // Denied: plain http gets the token only, never a proxy header (fe#295).
  @Test fun aPlainHttpOriginGetsTheTokenOnly() {
    assertEquals(
      mapOf("Authorization" to "Bearer t"),
      AuthScope.headersFor("http://192.168.1.20:8080", book),
    )
    assertNull(AuthScope.headersFor("http://192.168.1.20:8080", mapOf("X-Proxy" to "secret")))
  }

  @Test fun noHeadersAreNone() {
    assertNull(AuthScope.headersFor("https://books.example.com:443", null))
    assertNull(AuthScope.headersFor("https://books.example.com:443", emptyMap()))
  }
}
