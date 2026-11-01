package app.overtone.player.storage;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Key/value storage for secrets (access + refresh tokens, server URL),
 * encrypted with AES-256-GCM under a non-exportable key in the Android
 * Keystore. Values live in app-private SharedPreferences as base64(iv | ciphertext).
 *
 * Backs the web app's KeyValueStore interface on Android ("SecureStorage").
 * If a value can't be decrypted (e.g. the Keystore was reset), it is dropped
 * and reads return null: the user simply signs in again.
 */
@CapacitorPlugin(name = "SecureStorage")
public class SecureStoragePlugin extends Plugin {

  private static final String KEYSTORE = "AndroidKeyStore";
  private static final String KEY_ALIAS = "overtone.secure-storage.v1";
  private static final String PREFS = "overtone.secure-storage";
  private static final int IV_BYTES = 12;
  private static final int TAG_BITS = 128;

  private SharedPreferences prefs() {
    return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private static SecretKey key() throws Exception {
    KeyStore ks = KeyStore.getInstance(KEYSTORE);
    ks.load(null);
    if (!ks.containsAlias(KEY_ALIAS)) {
      KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
      gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build());
      return gen.generateKey();
    }
    return (SecretKey) ks.getKey(KEY_ALIAS, null);
  }

  static String encrypt(SecretKey key, String plaintext) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, key); // Keystore generates a random IV
    byte[] iv = cipher.getIV();
    byte[] ct = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
    return Base64.encodeToString(ByteBuffer.allocate(iv.length + ct.length).put(iv).put(ct).array(), Base64.NO_WRAP);
  }

  static String decrypt(SecretKey key, String stored) throws Exception {
    byte[] all = Base64.decode(stored, Base64.NO_WRAP);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, all, 0, IV_BYTES));
    return new String(cipher.doFinal(all, IV_BYTES, all.length - IV_BYTES), StandardCharsets.UTF_8);
  }

  @PluginMethod
  public void get(PluginCall call) {
    String k = call.getString("key");
    if (k == null) {
      call.reject("key is required");
      return;
    }
    JSObject r = new JSObject();
    String stored = prefs().getString(k, null);
    if (stored == null) {
      r.put("value", JSObject.NULL);
      call.resolve(r);
      return;
    }
    try {
      r.put("value", decrypt(key(), stored));
    } catch (Exception e) {
      prefs().edit().remove(k).apply(); // undecryptable (key reset): forget it
      r.put("value", JSObject.NULL);
    }
    call.resolve(r);
  }

  @PluginMethod
  public void set(PluginCall call) {
    String k = call.getString("key");
    String v = call.getString("value");
    if (k == null || v == null) {
      call.reject("key and value are required");
      return;
    }
    try {
      prefs().edit().putString(k, encrypt(key(), v)).apply();
      call.resolve();
    } catch (Exception e) {
      call.reject("Couldn't store the value securely", e);
    }
  }

  @PluginMethod
  public void remove(PluginCall call) {
    String k = call.getString("key");
    if (k == null) {
      call.reject("key is required");
      return;
    }
    prefs().edit().remove(k).apply();
    call.resolve();
  }
}
