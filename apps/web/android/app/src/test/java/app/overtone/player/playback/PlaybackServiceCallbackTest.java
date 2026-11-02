package app.overtone.player.playback;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.net.Uri;
import android.os.Bundle;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.datasource.DataSpec;
import com.getcapacitor.JSObject;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutionException;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Items from the app's MediaController carry the stream URL in RequestMetadata.mediaUri.
 * content:// is only accepted from the app itself; headers travel in RequestMetadata extras.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class PlaybackServiceCallbackTest {
  private static MediaItem fromController(String url) {
    return new MediaItem.Builder()
        .setMediaId(url)
        .setMediaMetadata(new MediaMetadata.Builder().setTitle("Song").build())
        .setRequestMetadata(new MediaItem.RequestMetadata.Builder().setMediaUri(Uri.parse(url)).build())
        .build();
  }

  @Test
  public void rebuildsPlayableItemsFromSignedStreamUrls() throws Exception {
    String url = "https://music.example.com/api/stream/12?st=1.12.999.sig";
    List<MediaItem> out = new PlaybackService.Callback(OWN).onAddMediaItems(null, null, Collections.singletonList(fromController(url))).get();
    assertEquals(Uri.parse(url), out.get(0).localConfiguration.uri);
    assertEquals("Song", String.valueOf(out.get(0).mediaMetadata.title));
  }

  @Test
  public void refusesNonHttpUris() {
    assertThrows(ExecutionException.class,
        () -> new PlaybackService.Callback(OWN).onAddMediaItems(null, null, Collections.singletonList(fromController("file:///sdcard/x.mp3"))).get());
  }

  private static final String OWN = "app.overtone.player";
  private static final String SAF = "content://com.android.externalstorage.documents/tree/primary%3AMusic/document/primary%3AMusic%2Fa.flac";

  @Test
  public void contentUrisOnlyFromThisApp() {
    assertTrue(PlaybackService.accepts(Uri.parse(SAF), OWN, OWN));
    assertFalse(PlaybackService.accepts(Uri.parse(SAF), "com.other.app", OWN));
    assertFalse(PlaybackService.accepts(Uri.parse(SAF), null, OWN));
    assertTrue(PlaybackService.accepts(Uri.parse("https://cdn.example/a.mp3"), "com.android.bluetooth", OWN));
    assertFalse(PlaybackService.accepts(Uri.parse("file:///data/data/app.overtone.player/x"), OWN, OWN));
    assertFalse(PlaybackService.accepts(Uri.parse("javascript:alert(1)"), OWN, OWN));
    // A controller we can't identify (null) can't queue content:// either.
    assertThrows(ExecutionException.class,
        () -> new PlaybackService.Callback(OWN).onAddMediaItems(null, null, Collections.singletonList(fromController(SAF))).get());
  }

  @Test
  public void headersTravelInExtrasAndAreAppliedPerUri() throws Exception {
    JSObject headers = new JSObject();
    headers.put("Authorization", "Bearer abc");
    MediaItem item = NativePlayerPlugin.mediaItem("https://cdn.example/a.mp3", null, headers);
    Bundle h = item.requestMetadata.extras.getBundle(PlaybackService.EXTRA_HEADERS);
    assertEquals("Bearer abc", h.getString("Authorization"));

    PlaybackService.RequestHeaders reg = new PlaybackService.RequestHeaders(2);
    reg.put(Uri.parse("https://cdn.example/a.mp3"), PlaybackService.toMap(h));
    DataSpec withH = reg.apply(new DataSpec(Uri.parse("https://cdn.example/a.mp3")));
    assertEquals("Bearer abc", withH.httpRequestHeaders.get("Authorization"));
    assertTrue(reg.apply(new DataSpec(Uri.parse("https://cdn.example/b.mp3"))).httpRequestHeaders.isEmpty());
    // Bounded: old entries fall out.
    reg.put(Uri.parse("https://x/1"), Collections.singletonMap("a", "1"));
    reg.put(Uri.parse("https://x/2"), Collections.singletonMap("a", "2"));
    assertNull(reg.get(Uri.parse("https://cdn.example/a.mp3")));
  }
}
