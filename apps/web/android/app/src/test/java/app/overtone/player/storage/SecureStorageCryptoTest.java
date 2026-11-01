package app.overtone.player.storage;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;

import android.util.Base64;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * AES-256-GCM format used by SecureStoragePlugin. (The Android Keystore itself
 * isn't available on the JVM; a software AES key exercises the same code path.)
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class SecureStorageCryptoTest {
  private static SecretKey key() throws Exception {
    KeyGenerator g = KeyGenerator.getInstance("AES");
    g.init(256);
    return g.generateKey();
  }

  @Test
  public void roundTripsAndUsesAFreshIvEachTime() throws Exception {
    SecretKey k = key();
    String token = "{\"refreshToken\":\"r-123\",\"accessToken\":\"a-456\"}";
    String a = SecureStoragePlugin.encrypt(k, token);
    String b = SecureStoragePlugin.encrypt(k, token);
    assertNotEquals(a, b);
    assertEquals(token, SecureStoragePlugin.decrypt(k, a));
    assertEquals(-1, a.indexOf("r-123"));
  }

  @Test
  public void rejectsTamperedOrForeignCiphertext() throws Exception {
    SecretKey k = key();
    byte[] raw = Base64.decode(SecureStoragePlugin.encrypt(k, "secret"), Base64.NO_WRAP);
    raw[raw.length - 1] ^= 1;
    String tampered = Base64.encodeToString(raw, Base64.NO_WRAP);
    assertThrows(Exception.class, () -> SecureStoragePlugin.decrypt(k, tampered));
    assertThrows(Exception.class, () -> SecureStoragePlugin.decrypt(key(), SecureStoragePlugin.encrypt(k, "secret")));
  }
}
