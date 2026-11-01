package app.overtone.player.playback;

import android.app.PendingIntent;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommand;
import app.overtone.player.MainActivity;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.ArrayList;
import java.util.List;

/**
 * Foreground media service (AndroidX Media3). Plays exactly the URLs the web
 * PlayerController gives it; the queue, shuffle/repeat and stream-link refresh
 * stay in JavaScript.
 *
 * What Media3 + this service provide natively:
 *  - MediaStyle notification (title, artist, artwork, play/pause/next/prev/seek),
 *    lock screen and Bluetooth / headset buttons via the MediaSession;
 *  - audio focus (pause for calls, duck for notifications, resume afterwards);
 *  - pause when headphones are unplugged (becoming noisy);
 *  - wake + Wi-Fi locks while streaming with the screen off;
 *  - near-gapless changes: the next track is queued as a second playlist item.
 *
 * Next/previous from the notification or a headset are not acted on here: they
 * are forwarded to the app (custom command {@link #REMOTE_COMMAND}) so the JS
 * queue decides what plays next.
 */
@OptIn(markerClass = UnstableApi.class)
public class PlaybackService extends MediaSessionService {

  public static final String REMOTE_COMMAND = "app.overtone.player.REMOTE";
  public static final String EXTRA_COMMAND = "command";
  static final String USER_AGENT = "Overtone-Android/1 (Media3)";

  @Nullable private MediaSession session;

  @Override
  public void onCreate() {
    super.onCreate();
    DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
        .setUserAgent(USER_AGENT)
        .setConnectTimeoutMs(15_000)
        .setReadTimeoutMs(20_000)
        // Redirect-mode sources (e.g. Internet Archive) may hop from http to https.
        .setAllowCrossProtocolRedirects(true);

    ExoPlayer exo = new ExoPlayer.Builder(this)
        .setMediaSourceFactory(new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, http)))
        .setAudioAttributes(
            new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
            /* handleAudioFocus= */ true)
        .setHandleAudioBecomingNoisy(true)
        .setWakeMode(C.WAKE_MODE_NETWORK)
        .build();

    Player player = new RemoteCommandPlayer(exo, this::forwardRemoteCommand);

    Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent openApp = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

    session = new MediaSession.Builder(this, player)
        .setSessionActivity(openApp)
        .setCallback(new Callback())
        .build();
  }

  @Nullable
  @Override
  public MediaSession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) {
    return session;
  }

  @Override
  public void onDestroy() {
    if (session != null) {
      session.getPlayer().release();
      session.release();
      session = null;
    }
    super.onDestroy();
  }

  private void forwardRemoteCommand(String command) {
    if (session == null) return;
    Bundle args = new Bundle();
    args.putString(EXTRA_COMMAND, command);
    session.broadcastCustomCommand(new SessionCommand(REMOTE_COMMAND, Bundle.EMPTY), args);
  }

  /**
   * Items arriving from a MediaController lose their URI in transit; the app
   * sends it in RequestMetadata.mediaUri (the documented pattern) and we
   * rebuild playable items here.
   */
  static final class Callback implements MediaSession.Callback {
    @NonNull
    @Override
    public ListenableFuture<List<MediaItem>> onAddMediaItems(
        @NonNull MediaSession mediaSession, @NonNull MediaSession.ControllerInfo controller, @NonNull List<MediaItem> mediaItems) {
      List<MediaItem> out = new ArrayList<>(mediaItems.size());
      for (MediaItem item : mediaItems) {
        Uri uri = item.requestMetadata.mediaUri;
        if (uri == null || !("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))) {
          return Futures.immediateFailedFuture(new IllegalArgumentException("Only http(s) media URIs are accepted"));
        }
        out.add(item.buildUpon().setUri(uri).build());
      }
      return Futures.immediateFuture(out);
    }
  }
}
