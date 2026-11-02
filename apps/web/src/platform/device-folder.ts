/** The Android folder picker for "This device" sources (no-op on the web). */
import { DeviceFolder, type DeviceFolderInfo } from '../standalone/plugins';
import { isNativeApp } from './server-url';

export async function pickDeviceFolder(): Promise<DeviceFolderInfo | null> {
  if (!isNativeApp()) throw new Error('Folders on this device can only be added in the Android app.');
  return (await DeviceFolder.pick()).folder;
}
