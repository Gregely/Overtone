package app.overtone.player.standalone;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Background work for standalone mode ("BackgroundWork"):
 *  - start/stop: the foreground service and its progress notification;
 *  - sleep: a native timer. Android's WebView throttles JavaScript timers
 *    hard in the background, which would stall MusicBrainz's 1 request/second
 *    pacing and retry backoff; a Handler on a background thread doesn't.
 */
@CapacitorPlugin(
    name = "BackgroundWork",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class BackgroundWorkPlugin extends Plugin {

  private HandlerThread timerThread;
  private Handler timers;

  @Override
  public void load() {
    timerThread = new HandlerThread("overtone-timers");
    timerThread.start();
    timers = new Handler(timerThread.getLooper());
  }

  @PluginMethod
  public void start(PluginCall call) {
    Intent i = new Intent(getContext(), BackgroundWorkService.class)
        .setAction(BackgroundWorkService.ACTION_UPDATE)
        .putExtra(BackgroundWorkService.EXTRA_TITLE, call.getString("title", "Updating your library"))
        .putExtra(BackgroundWorkService.EXTRA_TEXT, call.getString("text", ""));
    try {
      ContextCompat.startForegroundService(getContext(), i);
      call.resolve();
    } catch (RuntimeException e) {
      // Not allowed right now (app in the background on Android 12+): work continues while the app is open.
      call.reject("Couldn't show the background-work notification", "FGS_NOT_ALLOWED");
    }
  }

  @PluginMethod
  public void stop(PluginCall call) {
    getContext().stopService(new Intent(getContext(), BackgroundWorkService.class));
    call.resolve();
  }

  @PluginMethod
  public void sleep(PluginCall call) {
    long ms = Math.max(0, Math.min(24L * 3600_000L, call.getLong("ms", 0L)));
    timers.postDelayed(call::resolve, ms);
  }

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

  @Override
  protected void handleOnDestroy() {
    if (timerThread != null) timerThread.quitSafely();
  }
}
