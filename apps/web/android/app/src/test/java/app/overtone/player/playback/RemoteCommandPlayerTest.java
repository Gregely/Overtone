package app.overtone.player.playback;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/** Notification / headset next & previous go to the app (JS queue), not the native playlist. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class RemoteCommandPlayerTest {
  private ExoPlayer exo;
  private final List<String> forwarded = new ArrayList<>();
  private RemoteCommandPlayer player;

  @Before
  public void setUp() {
    exo = new ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build();
    exo.setMediaItems(Arrays.asList(MediaItem.fromUri("http://srv/a.mp3"), MediaItem.fromUri("http://srv/b.mp3")));
    player = new RemoteCommandPlayer(exo, forwarded::add);
  }

  @After
  public void tearDown() {
    exo.release();
  }

  @Test
  public void alwaysOffersNextAndPreviousButtons() {
    Player.Commands c = player.getAvailableCommands();
    assertTrue(c.contains(Player.COMMAND_SEEK_TO_NEXT));
    assertTrue(c.contains(Player.COMMAND_SEEK_TO_PREVIOUS));
    assertTrue(player.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM));
    assertTrue(player.isCommandAvailable(Player.COMMAND_PLAY_PAUSE)); // delegated
    assertTrue(player.hasNextMediaItem());
    assertTrue(player.hasPreviousMediaItem());
  }

  @Test
  public void forwardsNextAndPreviousWithoutMovingThePlaylist() {
    player.seekToNext();
    player.seekToNextMediaItem();
    player.seekToPrevious();
    player.seekToPreviousMediaItem();
    assertEquals(Arrays.asList("next", "next", "previous", "previous"), forwarded);
    assertEquals(0, exo.getCurrentMediaItemIndex());
  }

  @Test
  public void appTrackSwitchesStillWork() {
    player.seekTo(1, 0); // what NativePlayerPlugin uses to switch into the preloaded item
    assertEquals(1, exo.getCurrentMediaItemIndex());
    assertTrue(forwarded.isEmpty());
  }
}
