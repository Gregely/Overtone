package app.overtone.player.standalone;

import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
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
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * "This device" music folders through the Storage Access Framework.
 *
 * The user picks a folder in the system picker; the app takes a persisted,
 * read-only URI permission for that folder tree and nothing else (no storage
 * permission is requested). Everything here only works on documents inside a
 * folder the app currently holds a permission for; if the user revokes it
 * (system settings, or the folder disappears), calls fail with
 * PERMISSION_REVOKED / NOT_FOUND and the JS side shows a clear message.
 *
 * Listing is a stateless, paged depth-first walk: the cursor is the stack of
 * directories still to visit, so no native state survives between calls.
 * Reads are small ranged reads (seekable file descriptors where the provider
 * gives one), never whole files.
 */
@CapacitorPlugin(name = "DeviceFolder")
public class DeviceFolderPlugin extends Plugin {

  static final String REVOKED = "PERMISSION_REVOKED";
  static final String NOT_FOUND = "NOT_FOUND";
  static final int MAX_READ = 1024 * 1024;
  static final int MAX_PICTURE = 8 * 1024 * 1024;

  private final ExecutorService io = Executors.newFixedThreadPool(2);

  private ContentResolver resolver() {
    return getContext().getContentResolver();
  }

  // ── picking & permissions ────────────────────────────────────────────────

  @PluginMethod
  public void pick(PluginCall call) {
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
    startActivityForResult(call, intent, "onPicked");
  }

  @ActivityCallback
  private void onPicked(PluginCall call, ActivityResult result) {
    JSObject ret = new JSObject();
    Intent data = result.getData();
    if (result.getResultCode() != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
      ret.put("folder", JSONObject.NULL);
      call.resolve(ret);
      return;
    }
    Uri tree = data.getData();
    try {
      resolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
    } catch (SecurityException e) {
      call.reject("Android didn't grant lasting access to that folder. Try another folder.", REVOKED);
      return;
    }
    io.execute(() -> {
      JSObject folder = new JSObject();
      folder.put("uri", tree.toString());
      folder.put("name", folderName(tree));
      folder.put("granted", true);
      ret.put("folder", folder);
      call.resolve(ret);
    });
  }

  @PluginMethod
  public void folders(PluginCall call) {
    io.execute(() -> {
      JSArray list = new JSArray();
      for (UriPermission p : resolver().getPersistedUriPermissions()) {
        if (!p.isReadPermission()) continue;
        JSObject f = new JSObject();
        f.put("uri", p.getUri().toString());
        f.put("name", folderName(p.getUri()));
        f.put("granted", exists(p.getUri()));
        list.put(f);
      }
      JSObject ret = new JSObject();
      ret.put("folders", list);
      call.resolve(ret);
    });
  }

  /** Release persisted permissions for folders no source uses any more. */
  @PluginMethod
  public void prune(PluginCall call) {
    Set<String> keep = new HashSet<>();
    JSArray k = call.getArray("keep", new JSArray());
    for (int i = 0; i < k.length(); i++) keep.add(k.optString(i));
    for (UriPermission p : resolver().getPersistedUriPermissions()) {
      if (!keep.contains(p.getUri().toString())) {
        try {
          resolver().releasePersistableUriPermission(p.getUri(), Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
          // already gone
        }
      }
    }
    call.resolve();
  }

  /** The persisted tree that `uri` (a tree or a document inside one) belongs to, or null. */
  @Nullable
  private Uri grantedTree(String uri) {
    List<UriPermission> perms = resolver().getPersistedUriPermissions();
    for (UriPermission p : perms) {
      if (!p.isReadPermission()) continue;
      String tree = p.getUri().toString();
      if (uri.equals(tree) || uri.startsWith(tree + "/document/")) return p.getUri();
    }
    return null;
  }

  // ── listing ──────────────────────────────────────────────────────────────

  @PluginMethod
  public void list(PluginCall call) {
    String uri = call.getString("uri");
    String cursor = call.getString("cursor");
    int limit = Math.max(1, Math.min(2000, call.getInt("limit", 500)));
    io.execute(() -> {
      Uri tree = uri == null ? null : grantedTree(uri);
      if (tree == null) {
        call.reject("No access to this folder", REVOKED);
        return;
      }
      try {
        Deque<Dir> stack = cursor == null || cursor.isEmpty() ? null : decodeCursor(cursor);
        if (stack == null) {
          stack = new ArrayDeque<>();
          stack.push(new Dir(DocumentsContract.getTreeDocumentId(tree), ""));
        }
        JSArray files = new JSArray();
        boolean first = cursor == null || cursor.isEmpty();
        while (!stack.isEmpty() && files.length() < limit) {
          Dir dir = stack.pop();
          Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, dir.id);
          try (Cursor c = resolver().query(children, COLUMNS, null, null, null)) {
            if (c == null) {
              if (first) throw new FileNotFoundException("folder is gone");
              continue;
            }
            first = false;
            while (c.moveToNext()) {
              String id = c.getString(0);
              String name = c.getString(1);
              String mime = c.getString(2);
              if (id == null || name == null || name.startsWith(".")) continue;
              if (Document.MIME_TYPE_DIR.equals(mime)) {
                stack.push(new Dir(id, dir.path + name + "/"));
              } else {
                JSObject f = new JSObject();
                f.put("id", id);
                f.put("name", name);
                f.put("path", dir.path + name);
                f.put("size", c.isNull(3) ? 0 : c.getLong(3));
                f.put("modified", c.isNull(4) ? 0 : c.getLong(4));
                f.put("mime", mime == null ? JSONObject.NULL : mime);
                files.put(f);
              }
            }
          }
        }
        JSObject ret = new JSObject();
        ret.put("files", files);
        ret.put("cursor", stack.isEmpty() ? JSONObject.NULL : encodeCursor(stack));
        call.resolve(ret);
      } catch (SecurityException e) {
        call.reject("No access to this folder", REVOKED);
      } catch (FileNotFoundException | IllegalArgumentException e) {
        call.reject("Folder not found", NOT_FOUND);
      } catch (Exception e) {
        call.reject("Couldn't list the folder: " + e.getClass().getSimpleName());
      }
    });
  }

  private static final String[] COLUMNS = {
    Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED,
  };

  static final class Dir {
    final String id;
    final String path;

    Dir(String id, String path) {
      this.id = id;
      this.path = path;
    }
  }

  static String encodeCursor(Deque<Dir> stack) throws JSONException {
    JSONArray a = new JSONArray();
    // Deque iterates top-first; store bottom-first so decode can push in order.
    java.util.Iterator<Dir> it = stack.descendingIterator();
    while (it.hasNext()) {
      Dir d = it.next();
      a.put(new JSONArray().put(d.id).put(d.path));
    }
    return a.toString();
  }

  static Deque<Dir> decodeCursor(String cursor) throws JSONException {
    JSONArray a = new JSONArray(cursor);
    Deque<Dir> stack = new ArrayDeque<>();
    for (int i = 0; i < a.length(); i++) {
      JSONArray d = a.getJSONArray(i);
      stack.push(new Dir(d.getString(0), d.getString(1)));
    }
    return stack;
  }

  // ── reading ──────────────────────────────────────────────────────────────

  @PluginMethod
  public void read(PluginCall call) {
    String uri = call.getString("uri");
    long offset = Math.max(0, call.getLong("offset", 0L));
    int length = Math.max(0, Math.min(MAX_READ, call.getInt("length", 0)));
    io.execute(() -> {
      if (uri == null || grantedTree(uri) == null) {
        call.reject("No access to this file", REVOKED);
        return;
      }
      try {
        byte[] bytes = readRange(Uri.parse(uri), offset, length);
        JSObject ret = new JSObject();
        ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
        call.resolve(ret);
      } catch (SecurityException e) {
        call.reject("No access to this file", REVOKED);
      } catch (FileNotFoundException e) {
        call.reject("File not found", NOT_FOUND);
      } catch (Exception e) {
        call.reject("Couldn't read the file: " + e.getClass().getSimpleName());
      }
    });
  }

  private byte[] readRange(Uri uri, long offset, int length) throws Exception {
    try (ParcelFileDescriptor pfd = resolver().openFileDescriptor(uri, "r")) {
      if (pfd == null) throw new FileNotFoundException();
      try (FileInputStream in = new FileInputStream(pfd.getFileDescriptor()); FileChannel ch = in.getChannel()) {
        ByteBuffer buf = ByteBuffer.allocate(length);
        long pos = offset;
        while (buf.hasRemaining()) {
          int n = ch.read(buf, pos);
          if (n < 0) break;
          pos += n;
        }
        return java.util.Arrays.copyOf(buf.array(), buf.position());
      } catch (java.io.IOException seekFailed) {
        // Not seekable (a pipe from some providers): stream and skip instead.
        try (InputStream in = resolver().openInputStream(uri)) {
          if (in == null) throw new FileNotFoundException();
          long skipped = 0;
          while (skipped < offset) {
            long s = in.skip(offset - skipped);
            if (s <= 0) break;
            skipped += s;
          }
          byte[] out = new byte[length];
          int total = 0;
          while (total < length) {
            int n = in.read(out, total, length - total);
            if (n < 0) break;
            total += n;
          }
          return java.util.Arrays.copyOf(out, total);
        }
      }
    }
  }

  @PluginMethod
  public void stat(PluginCall call) {
    String uri = call.getString("uri");
    io.execute(() -> {
      if (uri == null || grantedTree(uri) == null) {
        call.reject("No access to this file", REVOKED);
        return;
      }
      JSObject ret = new JSObject();
      try (Cursor c = resolver().query(Uri.parse(uri), new String[] {Document.COLUMN_SIZE}, null, null, null)) {
        boolean found = c != null && c.moveToFirst();
        ret.put("exists", found);
        ret.put("size", found && !c.isNull(0) ? c.getLong(0) : 0);
        call.resolve(ret);
      } catch (SecurityException e) {
        call.reject("No access to this file", REVOKED);
      } catch (Exception e) {
        ret.put("exists", false);
        ret.put("size", 0);
        call.resolve(ret);
      }
    });
  }

  /** The embedded cover picture (MediaMetadataRetriever reads only what it needs). */
  @PluginMethod
  public void picture(PluginCall call) {
    String uri = call.getString("uri");
    io.execute(() -> {
      if (uri == null || grantedTree(uri) == null) {
        call.reject("No access to this file", REVOKED);
        return;
      }
      JSObject ret = new JSObject();
      MediaMetadataRetriever r = new MediaMetadataRetriever();
      try {
        r.setDataSource(getContext(), Uri.parse(uri));
        byte[] art = r.getEmbeddedPicture();
        String mime = art == null || art.length > MAX_PICTURE ? null : imageType(art);
        ret.put("data", mime == null ? JSONObject.NULL : Base64.encodeToString(art, Base64.NO_WRAP));
        ret.put("mimeType", mime == null ? JSONObject.NULL : mime);
        call.resolve(ret);
      } catch (SecurityException e) {
        call.reject("No access to this file", REVOKED);
      } catch (Exception e) {
        ret.put("data", JSONObject.NULL);
        ret.put("mimeType", JSONObject.NULL);
        call.resolve(ret);
      } finally {
        try {
          r.release();
        } catch (Exception ignored) {
          // nothing to do
        }
      }
    });
  }

  /** Image type from magic bytes (embedded pictures don't always say). */
  @Nullable
  static String imageType(byte[] b) {
    if (b.length >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff) return "image/jpeg";
    if (b.length >= 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
    if (b.length >= 6 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F') return "image/gif";
    if (b.length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "image/webp";
    return null;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private String folderName(Uri tree) {
    try {
      Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
      try (Cursor c = resolver().query(doc, new String[] {Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
        if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
      }
    } catch (Exception ignored) {
      // fall through
    }
    String last = tree.getLastPathSegment();
    return last == null ? "Folder" : last.substring(last.lastIndexOf(':') + 1);
  }

  private boolean exists(Uri tree) {
    try {
      Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
      try (Cursor c = resolver().query(doc, new String[] {Document.COLUMN_DOCUMENT_ID}, null, null, null)) {
        return c != null && c.moveToFirst();
      }
    } catch (Exception e) {
      return false;
    }
  }

  @Override
  protected void handleOnDestroy() {
    io.shutdown();
  }
}
