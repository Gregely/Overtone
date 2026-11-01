package app.overtone.player.playback;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import android.net.Uri;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutionException;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Items from the app's MediaController carry the stream URL in RequestMetadata.mediaUri. */
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
    List<MediaItem> out = new PlaybackService.Callback().onAddMediaItems(null, null, Collections.singletonList(fromController(url))).get();
    assertEquals(Uri.parse(url), out.get(0).localConfiguration.uri);
    assertEquals("Song", String.valueOf(out.get(0).mediaMetadata.title));
  }

  @Test
  public void refusesNonHttpUris() {
    assertThrows(ExecutionException.class,
        () -> new PlaybackService.Callback().onAddMediaItems(null, null, Collections.singletonList(fromController("file:///sdcard/x.mp3"))).get());
  }
}
