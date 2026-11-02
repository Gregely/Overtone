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
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommand;
import app.overtone.player.MainActivity;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
 *
 * Accepted media: http(s) URLs (server stream links in server mode, provider
 * links in standalone mode) and, only from this app's own controller,
 * content:// URIs of files in folders the user picked ("This device"). Items
 * may carry extra request headers (standalone providers that authenticate
 * with headers); they're attached to that item's HTTP requests only.
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

    // Per-item request headers (standalone mode), looked up by URI.
    ResolvingDataSource.Factory withHeaders = new ResolvingDataSource.Factory(http, HEADERS::apply);

    ExoPlayer exo = new ExoPlayer.Builder(this)
        // DefaultDataSource routes content:// to ContentDataSource and http(s) to `withHeaders`.
        .setMediaSourceFactory(new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, withHeaders)))
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
        .setCallback(new Callback(getPackageName()))
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

  /** Extra key (in RequestMetadata.extras) for a Bundle of request headers. */
  public static final String EXTRA_HEADERS = "app.overtone.player.HEADERS";

  /** Headers for the most recent items, by URI (bounded; only a handful are ever queued). */
  static final RequestHeaders HEADERS = new RequestHeaders(16);

  static final class RequestHeaders {
    private final Map<String, Map<String, String>> byUri;

    RequestHeaders(int max) {
      byUri = Collections.synchronizedMap(new LinkedHashMap<String, Map<String, String>>(max, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Map<String, String>> e) {
          return size() > max;
        }
      });
    }

    void put(Uri uri, @Nullable Map<String, String> headers) {
      if (headers == null || headers.isEmpty()) byUri.remove(uri.toString());
      else byUri.put(uri.toString(), Collections.unmodifiableMap(new HashMap<>(headers)));
    }

    @Nullable
    Map<String, String> get(Uri uri) {
      return byUri.get(uri.toString());
    }

    /** ResolvingDataSource.Resolver: add the item's headers to its requests. */
    DataSpec apply(DataSpec spec) {
      Map<String, String> h = get(spec.uri);
      return h == null ? spec : spec.withAdditionalHeaders(h);
    }
  }

  /**
   * Which media URIs a controller may queue. content:// opens files with this
   * app's folder permissions, so only the app itself may ask for those (the
   * session is exported for system controllers like Bluetooth and Android
   * Auto, and any app can connect to it).
   */
  static boolean accepts(@Nullable Uri uri, @Nullable String callerPackage, String ownPackage) {
    if (uri == null || uri.getScheme() == null) return false;
    switch (uri.getScheme()) {
      case "http":
      case "https":
        return true;
      case "content":
        return ownPackage.equals(callerPackage);
      default:
        return false;
    }
  }

  /**
   * Items arriving from a MediaController lose their URI in transit; the app
   * sends it in RequestMetadata.mediaUri (the documented pattern) and we
   * rebuild playable items here.
   */
  static final class Callback implements MediaSession.Callback {
    private final String ownPackage;

    Callback(String ownPackage) {
      this.ownPackage = ownPackage;
    }

    @NonNull
    @Override
    public ListenableFuture<List<MediaItem>> onAddMediaItems(
        @NonNull MediaSession mediaSession, @NonNull MediaSession.ControllerInfo controller, @NonNull List<MediaItem> mediaItems) {
      String caller = controller == null ? null : controller.getPackageName();
      List<MediaItem> out = new ArrayList<>(mediaItems.size());
      for (MediaItem item : mediaItems) {
        Uri uri = item.requestMetadata.mediaUri;
        if (!accepts(uri, caller, ownPackage)) {
          return Futures.immediateFailedFuture(new IllegalArgumentException("Only http(s) URIs, or this app's own content:// URIs, are accepted"));
        }
        Bundle extras = item.requestMetadata.extras;
        Bundle h = extras == null ? null : extras.getBundle(EXTRA_HEADERS);
        if (ownPackage.equals(caller)) HEADERS.put(uri, toMap(h));
        out.add(item.buildUpon().setUri(uri).build());
      }
      return Futures.immediateFuture(out);
    }
  }

  @Nullable
  static Map<String, String> toMap(@Nullable Bundle b) {
    if (b == null || b.isEmpty()) return null;
    Map<String, String> m = new HashMap<>();
    for (String k : b.keySet()) {
      String v = b.getString(k);
      if (v != null) m.put(k, v);
    }
    return m;
  }
}
