package app.overtone.player;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import app.overtone.player.playback.NativePlayerPlugin;
import app.overtone.player.standalone.AppStoragePlugin;
import app.overtone.player.standalone.BackgroundWorkPlugin;
import app.overtone.player.standalone.DeviceFolderPlugin;
import app.overtone.player.storage.SecureStoragePlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Local plugins must be registered before the bridge starts.
    registerPlugin(NativePlayerPlugin.class);
    registerPlugin(SecureStoragePlugin.class);
    registerPlugin(DeviceFolderPlugin.class);
    registerPlugin(BackgroundWorkPlugin.class);
    registerPlugin(AppStoragePlugin.class);
    super.onCreate(savedInstanceState);
    // Recommended with SystemBars insetsHandling (Capacitor 8 docs).
    EdgeToEdge.enable(this);
  }
}
