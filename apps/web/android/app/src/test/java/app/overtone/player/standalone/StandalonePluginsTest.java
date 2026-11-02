package app.overtone.player.standalone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayDeque;
import java.util.Deque;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class StandalonePluginsTest {

  @Test
  public void listingCursorRoundTripsTheDirectoryStack() throws Exception {
    Deque<DeviceFolderPlugin.Dir> stack = new ArrayDeque<>();
    stack.push(new DeviceFolderPlugin.Dir("primary:Music/A", "A/"));
    stack.push(new DeviceFolderPlugin.Dir("primary:Music/B \"quoted\"", "B \"quoted\"/"));
    Deque<DeviceFolderPlugin.Dir> back = DeviceFolderPlugin.decodeCursor(DeviceFolderPlugin.encodeCursor(stack));
    assertEquals(2, back.size());
    // Same order: the top of the stack is visited next.
    assertEquals("primary:Music/B \"quoted\"", back.pop().id);
    DeviceFolderPlugin.Dir a = back.pop();
    assertEquals("primary:Music/A", a.id);
    assertEquals("A/", a.path);
  }

  @Test
  public void sniffsEmbeddedPictureTypes() {
    assertEquals("image/jpeg", DeviceFolderPlugin.imageType(new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, 0}));
    assertEquals("image/png", DeviceFolderPlugin.imageType(new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10}));
    assertEquals("image/gif", DeviceFolderPlugin.imageType("GIF89a".getBytes()));
    assertEquals("image/webp", DeviceFolderPlugin.imageType("RIFF\0\0\0\0WEBPVP8 ".getBytes()));
    assertNull(DeviceFolderPlugin.imageType("<html>".getBytes()));
  }

  @Test
  public void appStorageNeverLeavesTheFilesDir() throws Exception {
    File root = Files.createTempDirectory("files").toFile();
    assertNotNull(AppStoragePlugin.confined(root, new File(root, "artwork/12.bin").getPath()));
    assertNull(AppStoragePlugin.confined(root, new File(root, "../shared_prefs/x.xml").getPath()));
    assertNull(AppStoragePlugin.confined(root, "/data/data/other.app/files/x"));
    assertNull(AppStoragePlugin.confined(root, root.getPath()));
    assertNull(AppStoragePlugin.confined(root, null));
  }
}
