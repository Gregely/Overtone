package app.overtone.player.playback;

import android.Manifest;
import android.content.ComponentName;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionResult;
import androidx.media3.session.SessionToken;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.ArrayDeque;
import java.util.Queue;

/**
 * JS ⇄ native bridge for the Media3 PlaybackService ("NativePlayer").
 *
 * Mirrors the web PlayerEngine interface: loadTrack / play / pause / seek /
 * preload / setVolume / unload, and emits events the JS NativeEngine maps
 * 1:1 onto engine events:
 *   state    { playing, playWhenReady, buffering }
 *   time     { position, duration }            (seconds, every 500 ms while playing)
 *   advanced { url }                            (auto-advanced into the preloaded item)
 *   ended    {}                                 (finished with nothing queued)
 *   error    { message, code, position }        (JS fetches a fresh link and resumes)
 *   remote   { command: "next" | "previous" }   (notification / headset buttons)
 *
 * All MediaController calls run on the main looper (Media3 requirement).
 */
@OptIn(markerClass = UnstableApi.class)
@CapacitorPlugin(
    name = "NativePlayer",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class NativePlayerPlugin extends Plugin {

  private final Handler main = new Handler(Looper.getMainLooper());
  @Nullable private MediaController controller;
  @Nullable private ListenableFuture<MediaController> connecting;
  private final Queue<Runnable> pending = new ArrayDeque<>();

  private final Runnable ticker = new Runnable() {
    @Override
    public void run() {
      if (controller != null && controller.isPlaying()) {
        emitTime(controller);
        main.postDelayed(this, 500);
      }
    }
  };

  // ── connection ───────────────────────────────────────────────────────────

  @Override
  public void load() {
    main.post(this::connect);
  }

  private void connect() {
    if (controller != null || connecting != null) return;
    SessionToken token = new SessionToken(getContext(), new ComponentName(getContext(), PlaybackService.class));
    connecting = new MediaController.Builder(getContext(), token).setListener(new MediaController.Listener() {
      @NonNull
      @Override
      public ListenableFuture<SessionResult> onCustomCommand(@NonNull MediaController c, @NonNull SessionCommand command, @NonNull Bundle args) {
        if (PlaybackService.REMOTE_COMMAND.equals(command.customAction)) {
          JSObject data = new JSObject();
          data.put("command", args.getString(PlaybackService.EXTRA_COMMAND, "next"));
          notifyListeners("remote", data);
        }
        return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
      }

      @Override
      public void onDisconnected(@NonNull MediaController c) {
        controller = null;
        connecting = null;
      }
    }).buildAsync();
    connecting.addListener(() -> {
      try {
        controller = connecting.get();
        controller.addListener(new Events());
        while (!pending.isEmpty()) pending.poll().run();
      } catch (Exception e) {
        connecting = null;
        JSObject data = new JSObject();
        data.put("message", "Couldn't start the playback service: " + e.getMessage());
        data.put("code", "SERVICE_UNAVAILABLE");
        data.put("position", 0);
        notifyListeners("error", data);
      }
    }, ContextCompat.getMainExecutor(getContext()));
  }

  /** Run with a connected controller, on the main looper. */
  private void withController(PluginCall call, ControllerTask task) {
    main.post(() -> {
      Runnable run = () -> {
        try {
          task.run(controller);
          if (call != null) call.resolve();
        } catch (Exception e) {
          if (call != null) call.reject(e.getMessage(), e);
        }
      };
      if (controller != null) run.run();
      else {
        pending.add(run);
        connect();
      }
    });
  }

  private interface ControllerTask {
    void run(MediaController c) throws Exception;
  }

  // ── methods ──────────────────────────────────────────────────────────────

  @PluginMethod
  public void loadTrack(PluginCall call) {
    String url = call.getString("url");
    if (url == null) {
      call.reject("url is required");
      return;
    }
    long startMs = Math.max(0, Math.round(call.getDouble("startAt", 0d) * 1000));
    boolean autoplay = Boolean.TRUE.equals(call.getBoolean("autoplay", true));
    MediaItem item = mediaItem(url, call.getObject("metadata"), call.getObject("headers"));
    withController(call, c -> {
      int idx = indexOf(c, url);
      int current = c.getCurrentMediaItemIndex();
      if (idx >= 0 && idx == current && c.getPlaybackState() != Player.STATE_IDLE) {
        c.seekTo(startMs);                       // same track: restart / resume position
      } else if (idx >= 0 && idx != current) {
        c.seekTo(idx, startMs);                  // the preloaded item: switch without re-buffering
        if (idx > 0) c.removeMediaItems(0, idx);
      } else {
        c.setMediaItem(item, startMs);
        c.prepare();
      }
      c.setPlayWhenReady(autoplay);
      if (autoplay) startTicker();
    });
  }

  @PluginMethod
  public void preload(PluginCall call) {
    String url = call.getString("url");
    MediaItem item = url == null ? null : mediaItem(url, call.getObject("metadata"), call.getObject("headers"));
    withController(call, c -> {
      int current = c.getCurrentMediaItemIndex();
      int count = c.getMediaItemCount();
      if (count == 0) return;
      if (item != null && current + 1 < count && url.equals(c.getMediaItemAt(current + 1).mediaId)) return;
      if (current + 1 < count) c.removeMediaItems(current + 1, count);
      if (item != null) c.addMediaItem(item);
    });
  }

  @PluginMethod
  public void play(PluginCall call) {
    withController(call, c -> {
      if (c.getPlaybackState() == Player.STATE_IDLE) c.prepare();
      c.play();
      startTicker();
    });
  }

  @PluginMethod
  public void pause(PluginCall call) {
    withController(call, Player::pause);
  }

  @PluginMethod
  public void seek(PluginCall call) {
    long ms = Math.max(0, Math.round(call.getDouble("position", 0d) * 1000));
    withController(call, c -> {
      c.seekTo(ms);
      emitTime(c);
    });
  }

  @PluginMethod
  public void setVolume(PluginCall call) {
    float v = (float) Math.max(0, Math.min(1, call.getDouble("volume", 1d)));
    withController(call, c -> c.setVolume(v));
  }

  @PluginMethod
  public void unload(PluginCall call) {
    withController(call, c -> {
      c.stop();
      c.clearMediaItems();
    });
  }

  /** Android 13+: ask for notification permission (called when playback first starts). */
  @PluginMethod
  public void requestNotificationPermission(PluginCall call) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
      JSObject r = new JSObject();
      r.put("granted", true);
      call.resolve(r);
      return;
    }
    requestPermissionForAlias("notifications", call, "onNotificationPermission");
  }

  @PermissionCallback
  private void onNotificationPermission(PluginCall call) {
    JSObject r = new JSObject();
    r.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
    call.resolve(r);
  }

  // ── events ───────────────────────────────────────────────────────────────

  private final class Events implements Player.Listener {
    @Override
    public void onIsPlayingChanged(boolean isPlaying) {
      emitState();
      if (isPlaying) startTicker();
    }

    @Override
    public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
      emitState();
    }

    @Override
    public void onPlaybackStateChanged(int state) {
      emitState();
      if (state == Player.STATE_ENDED && controller != null) {
        emitTime(controller);
        notifyListeners("ended", new JSObject());
      }
    }

    @Override
    public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
      if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO || item == null || controller == null) return;
      // Played straight into the preloaded track: tell JS (its queue advances), drop the finished item.
      JSObject data = new JSObject();
      data.put("url", item.mediaId);
      notifyListeners("advanced", data);
      int idx = controller.getCurrentMediaItemIndex();
      if (idx > 0) controller.removeMediaItems(0, idx);
    }

    @Override
    public void onPlayerError(@NonNull PlaybackException error) {
      JSObject data = new JSObject();
      data.put("message", error.getMessage() == null ? "Playback error" : error.getMessage());
      data.put("code", error.getErrorCodeName());
      data.put("position", controller == null ? 0 : controller.getCurrentPosition() / 1000.0);
      notifyListeners("error", data);
    }
  }

  private void emitState() {
    if (controller == null) return;
    JSObject data = new JSObject();
    data.put("playing", controller.isPlaying());
    // playWhenReady distinguishes "paused" (false) from "about to play / preparing" (true).
    data.put("playWhenReady", controller.getPlayWhenReady());
    data.put("buffering", controller.getPlaybackState() == Player.STATE_BUFFERING && controller.getPlayWhenReady());
    notifyListeners("state", data);
  }

  private void emitTime(MediaController c) {
    JSObject data = new JSObject();
    data.put("position", c.getCurrentPosition() / 1000.0);
    long d = c.getDuration();
    data.put("duration", d > 0 ? d / 1000.0 : 0);
    notifyListeners("time", data);
  }

  private void startTicker() {
    main.removeCallbacks(ticker);
    main.post(ticker);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private static int indexOf(MediaController c, String url) {
    for (int i = 0; i < c.getMediaItemCount(); i++) if (url.equals(c.getMediaItemAt(i).mediaId)) return i;
    return -1;
  }

  /**
   * mediaId = URL (for matching); the URI and any request headers travel in
   * RequestMetadata (see PlaybackService). Headers are never logged.
   */
  static MediaItem mediaItem(String url, @Nullable JSObject meta, @Nullable JSObject headers) {
    MediaMetadata.Builder md = new MediaMetadata.Builder();
    if (meta != null) {
      if (meta.has("title")) md.setTitle(meta.getString("title"));
      if (meta.has("artist")) md.setArtist(meta.getString("artist"));
      if (meta.has("album")) md.setAlbumTitle(meta.getString("album"));
      String art = meta.getString("artworkUrl");
      if (art != null) md.setArtworkUri(Uri.parse(art));
    }
    MediaItem.RequestMetadata.Builder request = new MediaItem.RequestMetadata.Builder().setMediaUri(Uri.parse(url));
    if (headers != null && headers.length() > 0) {
      Bundle h = new Bundle();
      for (java.util.Iterator<String> it = headers.keys(); it.hasNext(); ) {
        String k = it.next();
        String v = headers.optString(k, null);
        if (v != null) h.putString(k, v);
      }
      Bundle extras = new Bundle();
      extras.putBundle(PlaybackService.EXTRA_HEADERS, h);
      request.setExtras(extras);
    }
    return new MediaItem.Builder()
        .setMediaId(url)
        .setMediaMetadata(md.build())
        .setRequestMetadata(request.build())
        .build();
  }

  @Override
  protected void handleOnDestroy() {
    main.removeCallbacks(ticker);
    if (controller != null) controller.release();
    else if (connecting != null) MediaController.releaseFuture(connecting);
    controller = null;
    connecting = null;
  }
}
