package app.overtone.player.playback;

import androidx.annotation.OptIn;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;

/**
 * Wraps ExoPlayer so the notification, lock screen, Bluetooth and headset
 * "next" / "previous" buttons are always offered, but are forwarded to the
 * app instead of moving through the native playlist (which only ever holds
 * the current track and the preloaded next one).
 *
 * The app itself switches tracks with seekTo(mediaItemIndex, position), which
 * is not intercepted.
 */
@OptIn(markerClass = UnstableApi.class)
final class RemoteCommandPlayer extends ForwardingPlayer {

  interface Sink {
    void onRemoteCommand(String command);
  }

  private final Sink sink;

  RemoteCommandPlayer(Player player, Sink sink) {
    super(player);
    this.sink = sink;
  }

  @Override
  public Commands getAvailableCommands() {
    return super.getAvailableCommands()
        .buildUpon()
        .addAll(Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
        .build();
  }

  @Override
  public boolean isCommandAvailable(int command) {
    return command == Player.COMMAND_SEEK_TO_NEXT
        || command == Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM
        || command == Player.COMMAND_SEEK_TO_PREVIOUS
        || command == Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM
        || super.isCommandAvailable(command);
  }

  @Override public boolean hasNextMediaItem() { return true; }
  @Override public boolean hasPreviousMediaItem() { return true; }
  @Override public void seekToNext() { sink.onRemoteCommand("next"); }
  @Override public void seekToNextMediaItem() { sink.onRemoteCommand("next"); }
  @Override public void seekToPrevious() { sink.onRemoteCommand("previous"); }
  @Override public void seekToPreviousMediaItem() { sink.onRemoteCommand("previous"); }
}
