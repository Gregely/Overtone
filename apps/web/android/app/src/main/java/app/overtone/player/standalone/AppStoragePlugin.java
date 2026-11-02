package app.overtone.player.standalone;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.annotation.Nullable;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * App-private files for standalone mode ("AppStorage"): the artwork cache,
 * storage figures for Settings, and the system save/open pickers used by
 * library export/import. File access is confined to the app's files dir.
 */
@CapacitorPlugin(name = "AppStorage")
public class AppStoragePlugin extends Plugin {

  static final long MAX_IMPORT = 64L * 1024 * 1024;
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private String pendingSaveText;

  private File filesDir() {
    return getContext().getFilesDir();
  }

  /** `path` resolved inside the app's files dir, or null if it points anywhere else. */
  @Nullable
  static File confined(File root, @Nullable String path) {
    if (path == null) return null;
    try {
      File f = new File(path).getCanonicalFile();
      String base = root.getCanonicalPath() + File.separator;
      return f.getPath().startsWith(base) ? f : null;
    } catch (IOException e) {
      return null;
    }
  }

  @PluginMethod
  public void info(PluginCall call) {
    String db = call.getString("database", "overtone-library");
    io.execute(() -> {
      long bytes = 0;
      // @capacitor-community/sqlite stores "<name>SQLite.db".
      File main = getContext().getDatabasePath(db + "SQLite.db");
      for (String suffix : new String[] {"", "-wal", "-shm", "-journal"}) bytes += new File(main.getPath() + suffix).length();
      JSObject r = new JSObject();
      r.put("filesDir", filesDir().getAbsolutePath());
      r.put("databaseBytes", bytes);
      call.resolve(r);
    });
  }

  @PluginMethod
  public void writeFile(PluginCall call) {
    File f = confined(filesDir(), call.getString("path"));
    String data = call.getString("data");
    if (f == null || data == null) {
      call.reject("Invalid path");
      return;
    }
    io.execute(() -> {
      try {
        File dir = f.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("mkdirs");
        File tmp = new File(f.getPath() + ".tmp");
        try (OutputStream out = new FileOutputStream(tmp)) {
          out.write(Base64.decode(data, Base64.DEFAULT));
        }
        if (!tmp.renameTo(f)) throw new IOException("rename");
        call.resolve();
      } catch (Exception e) {
        call.reject("Couldn't save the file");
      }
    });
  }

  @PluginMethod
  public void readFile(PluginCall call) {
    File f = confined(filesDir(), call.getString("path"));
    if (f == null) {
      call.reject("Invalid path");
      return;
    }
    io.execute(() -> {
      JSObject r = new JSObject();
      try {
        r.put("data", f.isFile() ? Base64.encodeToString(Files.readAllBytes(f.toPath()), Base64.NO_WRAP) : JSONObject.NULL);
      } catch (IOException e) {
        r.put("data", JSONObject.NULL);
      }
      call.resolve(r);
    });
  }

  @PluginMethod
  public void deletePrefix(PluginCall call) {
    File dir = confined(filesDir(), call.getString("dir"));
    String prefix = call.getString("prefix", "");
    if (dir == null || prefix == null) {
      call.reject("Invalid path");
      return;
    }
    io.execute(() -> {
      File[] files = dir.listFiles();
      if (files != null) for (File f : files) if (f.isFile() && f.getName().startsWith(prefix)) f.delete();
      call.resolve();
    });
  }

  @PluginMethod
  public void dirSize(PluginCall call) {
    File dir = confined(filesDir(), call.getString("dir"));
    if (dir == null) {
      call.reject("Invalid path");
      return;
    }
    io.execute(() -> {
      JSObject r = new JSObject();
      r.put("bytes", size(dir));
      call.resolve(r);
    });
  }

  private static long size(File f) {
    if (f.isFile()) return f.length();
    long n = 0;
    File[] kids = f.listFiles();
    if (kids != null) for (File k : kids) n += size(k);
    return n;
  }

  // ── export / import pickers ──────────────────────────────────────────────

  @PluginMethod
  public void saveDocument(PluginCall call) {
    pendingSaveText = call.getString("text", "");
    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT)
        .addCategory(Intent.CATEGORY_OPENABLE)
        .setType(call.getString("mimeType", "application/json"))
        .putExtra(Intent.EXTRA_TITLE, call.getString("name", "overtone-library.json"));
    startActivityForResult(call, i, "onSaveDocument");
  }

  @ActivityCallback
  private void onSaveDocument(PluginCall call, ActivityResult result) {
    String text = pendingSaveText;
    pendingSaveText = null;
    Uri uri = result.getData() == null ? null : result.getData().getData();
    JSObject r = new JSObject();
    if (result.getResultCode() != Activity.RESULT_OK || uri == null || text == null) {
      r.put("saved", false);
      call.resolve(r);
      return;
    }
    io.execute(() -> {
      try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
        if (out == null) throw new IOException("no stream");
        out.write(text.getBytes(StandardCharsets.UTF_8));
        r.put("saved", true);
        call.resolve(r);
      } catch (Exception e) {
        call.reject("Couldn't save the export there. Try another location.");
      }
    });
  }

  @PluginMethod
  public void openDocument(PluginCall call) {
    JSArray types = call.getArray("mimeTypes", new JSArray());
    String[] mimes = new String[types.length()];
    for (int i = 0; i < types.length(); i++) mimes[i] = types.optString(i, "*/*");
    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, mimes);
    startActivityForResult(call, i, "onOpenDocument");
  }

  @ActivityCallback
  private void onOpenDocument(PluginCall call, ActivityResult result) {
    Uri uri = result.getData() == null ? null : result.getData().getData();
    JSObject r = new JSObject();
    if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
      r.put("name", JSONObject.NULL);
      r.put("text", JSONObject.NULL);
      call.resolve(r);
      return;
    }
    io.execute(() -> {
      try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
        if (in == null) throw new IOException("no stream");
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[64 * 1024];
        long total = 0;
        for (int n; (n = in.read(chunk)) > 0; ) {
          total += n;
          if (total > MAX_IMPORT) throw new IOException("too large");
          buf.write(chunk, 0, n);
        }
        r.put("name", displayName(uri));
        r.put("text", buf.toString(StandardCharsets.UTF_8.name()));
        call.resolve(r);
      } catch (Exception e) {
        call.reject("Couldn't read that file");
      }
    });
  }

  @Nullable
  private String displayName(Uri uri) {
    try (Cursor c = getContext().getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (c != null && c.moveToFirst()) return c.getString(0);
    } catch (Exception ignored) {
      // fall through
    }
    return null;
  }

  @Override
  protected void handleOnDestroy() {
    io.shutdown();
  }
}
