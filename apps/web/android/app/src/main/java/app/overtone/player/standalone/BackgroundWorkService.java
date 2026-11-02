package app.overtone.player.standalone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import app.overtone.player.MainActivity;
import app.overtone.player.R;

/**
 * Foreground service (type dataSync) that keeps the app process alive while
 * standalone mode scans sources or matches files with MusicBrainz, with a
 * visible, low-priority "Updating your library" notification. The work
 * itself runs in the app's JavaScript; this service only keeps it from being
 * frozen, and is stopped as soon as the work is done.
 *
 * Android 15+ limits dataSync services to 6 hours a day; onTimeout stops it.
 * If the process dies anyway, the work resumes from the database on next launch.
 */
public class BackgroundWorkService extends Service {

  static final String CHANNEL = "library-updates";
  static final int NOTIFICATION_ID = 4711;
  static final String ACTION_UPDATE = "app.overtone.player.work.UPDATE";
  static final String ACTION_STOP = "app.overtone.player.work.STOP";
  static final String EXTRA_TITLE = "title";
  static final String EXTRA_TEXT = "text";

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent == null || ACTION_STOP.equals(intent.getAction())) {
      stop();
      return START_NOT_STICKY;
    }
    String title = intent.getStringExtra(EXTRA_TITLE);
    String text = intent.getStringExtra(EXTRA_TEXT);
    Notification n = notification(title == null ? "Updating your library" : title, text == null ? "" : text);
    int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type);
    } catch (RuntimeException e) {
      // e.g. ForegroundServiceStartNotAllowedException when started from the background: just don't.
      stopSelf();
    }
    // Not sticky: if the system kills us, the app restarts the work itself on next launch.
    return START_NOT_STICKY;
  }

  private Notification notification(String title, String text) {
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
      NotificationChannel ch = new NotificationChannel(CHANNEL, "Library updates", NotificationManager.IMPORTANCE_LOW);
      ch.setDescription("Shown while Overtone scans your sources and matches files");
      ch.setShowBadge(false);
      nm.createNotificationChannel(ch);
    }
    Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent openApp = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    return new NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_library)
        .setContentTitle(title)
        .setContentText(text)
        .setOnlyAlertOnce(true)
        .setOngoing(true)
        .setSilent(true)
        .setProgress(0, 0, true)
        .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(openApp)
        .build();
  }

  private void stop() {
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
    stopSelf();
  }

  /** Android 15+: the daily dataSync budget ran out. */
  @Override
  public void onTimeout(int startId, int fgsType) {
    stop();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
